import type { PassportAPI } from "../shared/model";
declare global {
  interface Window {
    passport: PassportAPI;
  }
}
export const api = window.passport;
export const uuid = () => crypto.randomUUID();
export { errorMessage as message } from "../shared/errors";
