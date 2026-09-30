import fs from "node:fs/promises";
import { createRequire } from "node:module";

// Electron's BoringSSL does not expose the named 1024-bit modp2 group.
// Use the same RFC 2409 §6.2 prime explicitly in ssh2's group1 implementation.
// This does not enable group1; the application's per-host policy controls it.
const require = createRequire(import.meta.url);
const { version } = require("ssh2/package.json");
if (version !== "1.17.0")
  throw new Error("ssh2 버전이 변경되었습니다. modp2 호환 패치를 검토하세요.");
const filename = require.resolve("ssh2/lib/protocol/kex.js");
const source = await fs.readFile(filename, "utf8");
const original = "this._dh = createDiffieHellmanGroup(this.groupName);";
const replacement = `// Passport: explicit RFC 2409 group 2 for Electron/BoringSSL.
        this._dh = this.groupName === 'modp2'
          ? createDiffieHellman(Buffer.from(
              'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E08'
              + '8A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B'
              + '302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E'
              + '9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE'
              + '649286651ECE65381FFFFFFFFFFFFFFFF', 'hex'), 2)
          : createDiffieHellmanGroup(this.groupName);`;
if (!source.includes(replacement)) {
  if (source.split(original).length !== 2)
    throw new Error("ssh2의 DH 구현이 변경되었습니다. 호환 패치를 검토하세요.");
  await fs.writeFile(filename, source.replace(original, replacement));
  console.log("ssh2: Electron modp2 compatibility patch applied");
}
