"""Ephemeral loopback-only FTP/explicit FTPS fixture. Never used by the app."""
import sys
from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler, TLS_FTPHandler
from pyftpdlib.servers import FTPServer

root = sys.argv[1]
authorizer = DummyAuthorizer()
authorizer.add_user("tester", "test-only-password", root, perm="elradfmwMT")
handler = FTPHandler if len(sys.argv) < 3 else TLS_FTPHandler
handler.authorizer = authorizer
if len(sys.argv) >= 3:
    handler.certfile = sys.argv[2]
    handler.keyfile = sys.argv[3]
    handler.tls_control_required = True
    handler.tls_data_required = True
server = FTPServer(("127.0.0.1", 0), handler)
print(server.socket.getsockname()[1], flush=True)
server.serve_forever(timeout=0.05, blocking=True, handle_exit=True)
