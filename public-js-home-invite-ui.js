import { byId } from "/public-js-home-dom-utils.js";

export function installInviteUiGuards() {
  ["inviteCode", "inviteLink"].forEach((id) => {
    const node = byId(id);
    if (!node) return;
    node.readOnly = true;
    node.setAttribute("aria-readonly", "true");
  });
}
