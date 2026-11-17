// owner/repo 形式の名前を分ける
export const splitRepository = (repository: string): { owner: string; name: string } => {
  const [owner = "", name = ""] = repository.split("/");

  return { owner, name };
};
