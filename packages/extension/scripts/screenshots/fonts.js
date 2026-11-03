// `document.fonts.ready` is already settled when nothing has asked for a font yet, so a
// capture that waits on it alone can be taken in the fallback font. Asking for each face
// the pages use, with a character from its script, makes the wait real.

const FACES = ["400", "500", "600", "700"];

export async function fontsLoaded() {
  await Promise.all(
    FACES.flatMap((weight) => [
      document.fonts.load(`${weight} 20px Roboto`, "A"),
      document.fonts.load(`${weight} 20px "IBM Plex Sans Arabic"`, "\u0627"),
    ]),
  );
  await document.fonts.ready;
}
