from __future__ import annotations

import socket

from devtwin.system.ports import check_port, is_port_listening


def test_is_port_listening_true_for_bound_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        port = server.getsockname()[1]
        assert is_port_listening(port) is True


def test_is_port_listening_false_for_unused_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        server.bind(("127.0.0.1", 0))
        port = server.getsockname()[1]
        # bound but not listening -> not accepting connections
    assert is_port_listening(port) is False


def test_check_port_structure():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        port = server.getsockname()[1]
        info = check_port(port)
        assert info.port == port
        assert info.listening is True
        assert info.protocol == "tcp"
