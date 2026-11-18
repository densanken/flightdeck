import type { EvaluationResult } from "../usecase/evaluate/interface.js";

const code = (value: string): string => `\`${value.replace(/[\r\n`]/g, " ")}\``;

const guidance: Record<EvaluationResult["reason"], string> = {
  AUTHORIZED: "必要な同意を確認しました。",
  NO_CONTENT_CHANGES: "著者のコンテンツに対する認可は不要です。設定の変更は通常のレビューを受けてください。",
  EVALUATING: "認可を確認しています。",
  EDITOR_APPROVAL_MISSING: "対象の Editor に現在のコミットをレビューし、Approve するよう依頼してください。",
  TEAM_MAINTAINER_REQUIRED: "追加または削除する Team の Maintainer に現在のコミットの Approve を依頼してください。",
  WEBSITE_MEMBER_CONSENT_MISSING:
    "対象の Org Member Editor に website の変更を確認し、Approve するよう依頼してください。",
  INVALID_EDITORS:
    "各 meta.yaml または meta.yml の editors が空でなく、存在するユーザーまたは公開 Team を重複なく指定しているか確認してください。",
  INVALID_PROFILE: "profile.yaml または profile.yml の YAML と website の値を確認し、修正して push してください。",
  INITIAL_AUTHOR_NOT_EDITOR: "新しい著者の editors に PR 作成者自身か、作成者が所属する Team を指定してください。",
  NON_CONTENT_CHANGE_FORBIDDEN:
    "以下の対象外ファイルを PR から取り除いて push してください。設定や検証スクリプトの変更を提案する場合は Issue を作成してください。",
  AUTHOR_ROOT_CASE_CONFLICT:
    "既存の著者ディレクトリと大文字小文字だけが異なる名前を避け、既存ディレクトリを使うか別の名前に変更してください。",
  COMMIT_IDENTITY_MISMATCH:
    "各コミットの author と committer を PR 作成者の GitHub アカウントに合わせて作成し直し、push してください。",
  INCOMPLETE_DATA:
    "差分・コミット・所属情報などを完全に取得できませんでした。変更やコミットを減らして push するか、管理者に再実行を依頼してください。",
  API_ERROR: "GitHub の情報を確認できませんでした。しばらく待ってから管理者に再実行を依頼してください。",
  YAML_SIZE_LIMIT:
    "meta / profile の YAML を各ファイル 16 KiB 以下、変更対象の解析合計を 64 KiB 以下に整理して push してください。",
  SUBREQUEST_LIMIT: "変更や確認対象を減らして PR を分割し、再度 push してください。",
};

export const authorizationComment = (result: EvaluationResult): string => {
  const { authorRoots = [], otherPaths = [], invalidCommits: bad = [] } = result.facts ?? {};
  const unlinked = bad.filter((commit) => commit.authorId === null);
  const lines = [
    "<!-- boarding:authorization -->",
    "## 認可結果",
    `状態: ${code(result.status)} / ${code(result.reason)}`,
    "モード: 通常の認可",
    `対象著者: ${result.facts ? (authorRoots.length ? authorRoots.map(code).join(", ") : "なし") : "取得できませんでした"}`,
    `コミットの本人確認: ${result.facts ? (bad.length === 0 ? "一致" : "確認できないコミットがあります") : "取得できませんでした"}`,
    guidance[result.reason],
  ];

  if (result.details?.memberships) {
    lines.push("### Org / Team の判定");
    lines.push(
      ...result.details.memberships.map((membership) => {
        const teams = Object.entries(membership.teams)
          .map(([slug, role]) => `${code(slug)}: ${role ?? "所属なし"}`)
          .join(", ");
        return `- ${code(membership.login)}: Org ${membership.orgRole === undefined ? "未確認" : (membership.orgRole ?? "所属なし")}${teams ? ` / Team ${teams}` : ""}`;
      })
    );
  } else {
    lines.push("Org / Team の判定: この評価では確認できませんでした。");
  }

  if (result.status === "waiting") {
    lines.push(`不足している同意: ${result.details?.root ? code(result.details.root) : "対象著者を確認してください"}`);
    const missing = result.details?.missing;
    if (missing) {
      lines.push(
        `必要な同意: ${missing.editors.map(code).join(", ")} ${missing.kind === "all" ? "の全員" : "のうち1名"}`
      );
    }
  }

  lines.push("website の追加または変更には対象の Org Member Editor の同意が必要です。");

  if (otherPaths.length > 0) {
    if (result.reason !== "NON_CONTENT_CHANGE_FORBIDDEN") {
      lines.push(
        "Org Member でない PR 作成者は、次の著者コンテンツ以外の変更を取り除いてください。設定や検証スクリプトの変更は Issue で提案できます。"
      );
    }
    lines.push(...otherPaths.map((path) => `- ${code(path)}`));
    lines.push(
      "例: 対象ファイルを base の状態に戻してコミットするには、`git restore --source origin/main -- <ファイル>` を実行し、変更をコミットして push してください。新規ファイルは削除してコミットしてください。"
    );
  }

  if (bad.length > 0) lines.push(`本人確認に失敗したコミット: ${bad.map((commit) => code(commit.sha)).join(", ")}`);

  if (unlinked.length > 0) {
    lines.push(
      "GitHub アカウントにメールアドレスを紐づけられないコミットがあります。GitHub の Settings → Emails でコミットに使ったアドレスを追加するか、GitHub の noreply アドレスでコミットし直して push してください。"
    );
    lines.push(
      ...unlinked.map(
        (commit) =>
          `- ${code(commit.sha)}: ${commit.authorEmail && /^[^\s@]+@users\.noreply\.github\.com$/i.test(commit.authorEmail) ? code(commit.authorEmail) : "メールアドレスは非表示"}`
      )
    );
  }

  return lines.join("\n\n");
};
