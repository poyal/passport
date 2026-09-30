import { createServer } from "node:net";

// SSH/FTP fixtures and Playwright's Electron debugger need localhost sockets.
// Reject restricted runners before launching Electron and triggering OS alerts.
export default async function checkTestEnvironment() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", (error) => {
      reject(
        new Error(
          `테스트에 필요한 localhost 서버를 열 수 없습니다 (${error.code}). 데스크톱 세션과 로컬 네트워크 실행을 허용한 환경에서 다시 실행하세요.`,
          { cause: error },
        ),
      );
    });
    server.listen(0, "127.0.0.1", () => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
}
