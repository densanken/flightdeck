import { truncateText } from "../../util/truncate.js";

// Discord の autocomplete 候補の name は 100 文字までで、超えると候補全体が拒否される
const MAX_CHOICE_NAME_LENGTH = 100;

export const truncateChoiceName = (name: string): string => truncateText(name, MAX_CHOICE_NAME_LENGTH);
