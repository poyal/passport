export type UpdateState = {
  status: "idle" | "checking" | "current" | "available" | "error";
  currentVersion: string;
  latestVersion: string | null;
  checkedAt: number | null;
  installerAvailable: boolean;
  message: string;
};

export const initialUpdateState = (currentVersion: string): UpdateState => ({
  status: "idle",
  currentVersion,
  latestVersion: null,
  checkedAt: null,
  installerAvailable: false,
  message: "GitHub Releases에서 새 버전을 확인할 수 있습니다.",
});
