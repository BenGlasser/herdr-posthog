// How the panel looks in any layout: the theme's colors and the layout's own fonts. In a Nightdrive
// layout (theme "nightdrive") titles take its pixel face after a "//", and dialogs get its corner
// marks, like the rest of Nightdrive's panels. Nightdrive brings that face; elsewhere it isn't used.
import { div } from "gpui-kit";
import { layout } from "herdr";

const DISPLAY = "Press Start 2P";
export const nightdrive = () => JSON.stringify(layout()?.theme ?? "").includes("nightdrive");

// A title in `color`: Nightdrive's pixel face at `size`, else the layout's font, bold and larger.
export function face(t, text, color = t.accent, size = 8) {
  return nightdrive() ? div().font_family(DISPLAY).text_size(size).text_color(color).child(text)
    : div().text_size(size + 3.5).font_bold().text_color(color).child(text);
}

// A panel or section title, as children: "// TITLE" in Nightdrive, else the title alone.
export function title(t, text, color = t.accent) {
  return nightdrive() ? [div().text_color(t.solid).child("//"), face(t, text, color)] : [face(t, text, color)];
}

// Nightdrive's corner marks on a dialog's frame (none elsewhere), as children of a relative element.
export function reticle(t, size = 12) {
  if (!nightdrive()) return [];
  const c = t.solid;
  return [
    div().absolute().top(0).left(0).w(size).h(2).bg(c),
    div().absolute().top(0).left(0).w(2).h(size).bg(c),
    div().absolute().bottom(0).right(0).w(size).h(2).bg(c),
    div().absolute().bottom(0).right(0).w(2).h(size).bg(c),
  ];
}
