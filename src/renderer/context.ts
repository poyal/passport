import { createContext, useContext } from "react";
import type {
  Bootstrap,
  PassportDocument,
  Host,
  SessionState,
  TransferJob,
  Appearance,
  Secret,
  Activity,
} from "../shared/model";
export type AppContextValue = {
  activities: Activity[];
  boot: Bootstrap;
  document: PassportDocument;
  update: (fn: (doc: PassportDocument) => PassportDocument) => Promise<boolean>;
  refresh: () => Promise<void>;
  notify: (message: unknown) => void;
  ask: (
    title: string,
    description: string,
    initial?: string,
  ) => Promise<string | null>;
  confirm: (title: string, description: string) => Promise<boolean>;
  credentials: (
    host: Host,
    sftp?: boolean,
  ) => Promise<Secret | undefined | null>;
  openHost: (host: Host) => Promise<void>;
  connectPane: (id: string, hostId: string) => Promise<void>;
  settingsSection: string;
  openSettings: (section: string) => void;
  active: string;
  setActive: (id: string) => void;
  activePane: string;
  setActivePane: (id: string) => void;
  sessionStates: Record<string, SessionState>;
  jobs: TransferJob[];
  fileRequest: { side: number; hostId: string; nonce: number } | null;
  openFiles: (host: Host, side: number) => void;
  paste: (text: string, ids: string[]) => void;
  sessionAppearance: Record<string, Partial<Appearance>>;
  setSessionAppearance: (id: string, value: Partial<Appearance>) => void;
};
export const AppContext = createContext<AppContextValue | null>(null);
export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error("앱이 준비되지 않았습니다.");
  return value;
}
