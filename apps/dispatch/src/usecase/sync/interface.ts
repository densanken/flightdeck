// 一時的な失敗や競合で再実行が必要な場合は DispatchError("retryable") を throw する
// 恒久的な失敗（設定不正や権限不足など）は DispatchError で throw し、呼び出し側が記録して再実行しない
// 事前の処理（handlePush と handleDefaultBranchChanged）は読み取りと子 message の積み込みだけを行い、
// 書き込みは子 message の処理（syncTarget と closeTarget）が行う
export interface SyncUseCase {
  // push された branch が source の default branch なら source として target ごとに、
  // その branch を base とする管理 PR があれば parent として管理 branch の source ごとに、子 message を積む
  // before は push の前の HEAD（branch を新しく作った push では undefined）
  handlePush(input: { repository: string; branch: string; before?: string }): Promise<void>;
  // source としては新しい default branch と旧 default branch の設定を使い、parent としては全管理 PR を対象にする
  handleDefaultBranchChanged(input: { repository: string; previousDefaultBranch: string }): Promise<void>;
  // source の現在の設定に従い、target の 1 件を同期する（parent の push と、管理 branch の push や PR の event では、target は parent の正規名）
  syncTarget(input: { source: string; target: string }): Promise<void>;
  // 設定から削除された target の管理 PR を Close する
  closeTarget(input: { source: string; target: string }): Promise<void>;
}
