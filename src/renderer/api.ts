import type { PassportAPI } from "../shared/model";
declare global {
  interface Window {
    passport: PassportAPI;
  }
}
export const api = window.passport;
export const uuid = () => crypto.randomUUID();
export const message = (error: unknown) =>
  error instanceof Error ? error.message : "작업에 실패했습니다.";
