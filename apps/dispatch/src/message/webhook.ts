import { commitSha, githubId, repositoryFullName } from "@flightdeck/validation";
import * as v from "valibot";

// Queue に載せるのは処理に必要な最小限の情報だけで、Webhook 全文は保存しない
// push と default branch の変更は Webhook から、sync-target と close-target はその処理が target ごとに分けて積む子 message
// 管理 branch への push と、管理 branch の PR が開かれたか base が変わったときは、Webhook から sync-target を直接積む
// installation は event の repository の owner と、Webhook が署名つきで運ぶ Installation の ID
// token の発行はこの owner だけを起点にする
const common = {
  deliveryId: v.string(),
  installation: v.object({ owner: v.string(), id: githubId }),
};

export const dispatchMessageSchema = v.variant("event", [
  // before は branch を新しく作った push では省く
  v.object({
    ...common,
    event: v.literal("push"),
    repository: repositoryFullName,
    branch: v.string(),
    before: v.optional(commitSha),
  }),
  v.object({
    ...common,
    event: v.literal("default-branch-changed"),
    repository: repositoryFullName,
    previousDefaultBranch: v.string(),
  }),
  // source は子 message を積んだ source、target は設定に書かれた parent の名前
  // parent の push と、管理 branch の push や PR の event では、source は管理 branch 名から戻した source、target は parent の正規名
  v.object({
    ...common,
    event: v.picklist(["sync-target", "close-target"]),
    source: repositoryFullName,
    target: repositoryFullName,
  }),
]);

export type DispatchMessage = v.InferOutput<typeof dispatchMessageSchema>;
