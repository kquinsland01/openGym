#!/usr/bin/env python3
"""K8S-20: exercise the built nginx image against isolated IPv4/IPv6 fixtures."""
import http.client
import http.server
import json
import os
from pathlib import Path
import socket
import socketserver
import struct
import subprocess
import sys
import threading
import time
import uuid

RUNTIME = os.environ.get('CONTAINER_RUNTIME', 'podman')
IMAGE = None


class Backend(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({'family': self.server.address_family, 'path': self.path}).encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


class IPv6HTTP(http.server.ThreadingHTTPServer):
    address_family = socket.AF_INET6

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        super().server_bind()


class DNS(socketserver.BaseRequestHandler):
    def handle(self):
        packet, sock = self.request
        offset, labels = 12, []
        while packet[offset]:
            size = packet[offset]
            labels.append(packet[offset + 1:offset + size + 1].decode())
            offset += size + 1
        offset += 1
        kind, dns_class = struct.unpack('!HH', packet[offset:offset + 4])
        question = packet[12:offset + 4]
        name = '.'.join(labels)
        self.server.queries.add((name, kind))
        address = None
        if name == 'api-v6.test' and kind == 28:
            address = socket.inet_pton(socket.AF_INET6, '::1')
        elif name == 'api-v4.test' and kind == 1:
            address = socket.inet_aton('127.0.0.1')
        answer = b''
        if address:
            answer = b'\xc0\x0c' + struct.pack('!HHIH', kind, dns_class, 1, len(address)) + address
        header = packet[:2] + struct.pack('!HHHHH', 0x8180, 1, bool(address), 0, 0)
        sock.sendto(header + question + answer, self.client_address)


class IPv6DNS(socketserver.UDPServer):
    address_family = socket.AF_INET6


def run(*args, **kwargs):
    return subprocess.run([RUNTIME, *args], check=True, text=True, capture_output=True,
                          timeout=60, **kwargs).stdout.strip()


def get(host, port, path):
    conn = http.client.HTTPConnection(host, port, timeout=2)
    try:
        conn.request('GET', path)
        response = conn.getresponse()
        return response.status, response.read()
    finally:
        conn.close()


def check_image(env, family, expect_v6):
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    name = 'opengym-ipv6-' + uuid.uuid4().hex[:12]
    args = ['run', '-d', '--name', name, '--network=host', '-e', f'NGINX_PORT={port}']
    for key, value in env.items():
        args += ['-e', f'{key}={value}']
    try:
        run(*args, IMAGE)
        deadline = time.monotonic() + 20
        while True:
            try:
                assert get('127.0.0.1', port, '/')[0] == 200
                break
            except (OSError, AssertionError):
                if time.monotonic() > deadline:
                    raise AssertionError('nginx did not start: ' + run('logs', name))
                time.sleep(.1)
        for path in ['/api/health', '/api/media/example']:
            status, body = get('127.0.0.1', port, path)
            assert status == 200, (status, body, run('logs', name))
            assert json.loads(body) == {'family': family, 'path': path}
        if expect_v6:
            assert get('::1', port, '/')[0] == 200
            status, body = get('::1', port, '/api/health')
            assert status == 200 and json.loads(body)['family'] == family
        else:
            try:
                get('::1', port, '/')
            except OSError:
                pass
            else:
                raise AssertionError('IPv6 socket remained open with NGINX_IPV6=off')
    finally:
        subprocess.run([RUNTIME, 'rm', '-f', name], capture_output=True, timeout=30)


def normalization_checks():
    helper = Path(__file__).resolve().parents[2] / 'web/15-network.envsh'
    for resolver, backend, expected in [
        ('fd00:10:96::a', 'fd00:10:96::123', '[fd00:10:96::a]|[fd00:10:96::123]'),
        ('[::1]:5353', '[::1]', '[::1]:5353|[::1]'),
        ('10.0.0.10:5353 ::1', 'api', '10.0.0.10:5353 [::1]|api'),
    ]:
        result = subprocess.run(['sh', '-c', '. "$1"; printf "%s|%s" "$RESOLVER" "$BACKEND"',
                                 'sh', str(helper)], env={**os.environ, 'RESOLVER': resolver,
                                                         'BACKEND': backend},
                                capture_output=True, text=True, check=True)
        assert result.stdout == expected, result.stdout
    for invalid in ['NGINX_IPV6', 'RESOLVER_IPV6']:
        result = subprocess.run(['sh', str(helper)], env={**os.environ, invalid: 'invalid'},
                                capture_output=True)
        assert result.returncode != 0


def main():
    global IMAGE
    if len(sys.argv) != 2:
        raise SystemExit('usage: test_web_ipv6.py IMAGE')
    IMAGE = sys.argv[1]
    normalization_checks()
    servers = []
    try:
        # IPv6 socket creation fails explicitly on an unsuitable host; never report a skipped pass.
        v6 = IPv6HTTP(('::1', 0), Backend)
        servers.append(v6)
        v4 = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Backend)
        servers.append(v4)
        dns = IPv6DNS(('::1', 0), DNS)
        dns.queries = set()
        servers.append(dns)
        for server in servers:
            threading.Thread(target=server.serve_forever, daemon=True).start()
        resolver = f'[::1]:{dns.server_address[1]}'
        check_image({'BACKEND': 'api-v6.test', 'PORT': str(v6.server_port), 'RESOLVER': resolver},
                    socket.AF_INET6, True)
        assert ('api-v6.test', 28) in dns.queries, dns.queries
        print('PASS: IPv4/IPv6 listeners, AAAA-only API/media backend, IPv6 DNS transport')
        check_image({'BACKEND': '::1', 'PORT': str(v6.server_port)}, socket.AF_INET6, True)
        print('PASS: raw IPv6 backend literal')
        check_image({'BACKEND': 'api-v4.test', 'PORT': str(v4.server_port), 'RESOLVER': resolver},
                    socket.AF_INET, True)
        assert ('api-v4.test', 1) in dns.queries and ('api-v4.test', 28) in dns.queries
        print('PASS: default dual-stack configuration with an A-only IPv4 backend')
        dns.queries.clear()
        check_image({'BACKEND': 'api-v4.test', 'PORT': str(v4.server_port), 'RESOLVER': resolver,
                     'NGINX_IPV6': 'off', 'RESOLVER_IPV6': 'off'}, socket.AF_INET, False)
        assert ('api-v4.test', 1) in dns.queries and ('api-v4.test', 28) not in dns.queries
        print('PASS: IPv4-only listener and A-only DNS opt-outs')
        print('PASS: raw/bracketed/multiple DNS normalization and invalid setting rejection')
    finally:
        for server in servers:
            server.server_close()


if __name__ == '__main__':
    main()
