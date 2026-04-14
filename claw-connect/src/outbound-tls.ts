import fs from "fs";
import type { TLSSocket } from "tls";
import { Agent, buildConnector } from "undici";
import { extractFingerprint } from "./middleware.js";

/**
 * Build an undici Dispatcher that performs client mTLS authentication AND
 * pins the remote peer's certificate fingerprint.
 *
 * After the TLS handshake completes, the peer's raw DER certificate is
 * hashed and compared to `expectedFingerprint`. If they do not match, the
 * socket is destroyed and the connection fails before any HTTP bytes are
 * exchanged. This closes the MITM hole left by `rejectUnauthorized: false`,
 * which is required because Claw Connect uses self-signed certificates
 * validated by fingerprint rather than by a CA.
 */
export function buildPinnedDispatcher(
  certPath: string,
  keyPath: string,
  expectedFingerprint: string,
): Agent {
  const cert = fs.readFileSync(certPath, "utf-8");
  const key = fs.readFileSync(keyPath, "utf-8");

  // Delegate the actual TLS connect to undici's default connector so we
  // inherit its session caching, ALPN, SNI, and timeout behavior. We only
  // layer a fingerprint check on top of its result.
  const baseConnect = buildConnector({
    cert,
    key,
    // Self-signed certs mean CA-based verification will always fail. We
    // intentionally skip it and verify authenticity via the pinned
    // fingerprint instead.
    rejectUnauthorized: false,
  });

  const pinnedConnect: buildConnector.connector = (opts, callback) => {
    baseConnect(opts, (err, socket) => {
      if (err || !socket) {
        callback(err ?? new Error("TLS connect returned no socket"), null);
        return;
      }

      const tlsSocket = socket as TLSSocket;
      const peerCert = tlsSocket.getPeerCertificate(true);
      if (!peerCert || !peerCert.raw || peerCert.raw.length === 0) {
        tlsSocket.destroy();
        callback(new Error("Peer did not present a certificate"), null);
        return;
      }

      const actual = extractFingerprint(peerCert.raw);
      if (actual !== expectedFingerprint) {
        tlsSocket.destroy();
        callback(
          new Error(
            `Peer cert fingerprint mismatch: expected ${expectedFingerprint}, got ${actual ?? "<none>"}`,
          ),
          null,
        );
        return;
      }

      callback(null, socket);
    });
  };

  return new Agent({ connect: pinnedConnect });
}
