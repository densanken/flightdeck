import { z } from "zod";

// Queue に載せるのは処理に必要な最小限の情報だけで、Webhook 全文は保存しない
// push と default branch の変更は Webhook から、sync-target と close-target はその処理が target ごとに分けて積む子 message
// 管理 branch への push と、管理 branch の PR が開かれたか base が変わったときは、Webhook から sync-target を直接積む
// installation は event の repository の owner と、Webhook が署名つきで運ぶ Installation の ID
// token の発行はこの owner だけを起点にする
const common = {
  deliveryId: z.string(),
  installation: z.object({ owner: z.string(), id: z.number() }),
};

export const dispatchMessageSchema = z.discriminatedUnion("event", [
  // before は branch を新しく作った push では省く
  z.object({
    ...common,
    event: z.literal("push"),
    repository: z.string(),
    branch: z.string(),
    before: z.string().optional(),
  }),
  z.object({
    ...common,
    event: z.literal("default-branch-changed"),
    repository: z.string(),
    previousDefaultBranch: z.string(),
  }),
  // source は子 message を積んだ source、target は設定に書かれた parent の名前
  // parent の push と、管理 branch の push や PR の event では、source は管理 branch 名から戻した source、target は parent の正規名
  z.object({ ...common, event: z.enum(["sync-target", "close-target"]), source: z.string(), target: z.string() }),
]);

export type DispatchMessage = z.infer<typeof dispatchMessageSchema>;
