import { hasDraftTitleMarker } from "@flightdeck/pr-title";

// 判定は preflight と共有する
// 両アプリで結果がずれないよう @flightdeck/pr-title を単一の出所にする
export const isMarkedDraft = (title: string): boolean => hasDraftTitleMarker(title);
