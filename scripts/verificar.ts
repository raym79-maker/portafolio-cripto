// Revisa la pagina tal como la sirve el servidor.
// Evalua la plantilla PAGE igual que Bun y le pasa el parser al <script>,
// que es justo donde se colo el error que dejo el portafolio sin login.
const src = await Bun.file("index.ts").text();
const i = src.indexOf("const PAGE = `");
if (i < 0) { console.error("no encontre la plantilla PAGE"); process.exit(1); }
const j = src.indexOf("\n`;\n", i);
const PAGE: string = eval("`" + src.slice(i + "const PAGE = `".length, j) + "`");

const a = PAGE.indexOf("<script>"), b = PAGE.lastIndexOf("</script>");
const cliente = PAGE.slice(a + 8, b);

try {
  new Function(cliente);
} catch (e: any) {
  console.error("ERROR en el script del navegador:", e.message);
  const m = /line (\d+)/.exec(e.stack || "");
  if (m) console.error(cliente.split("\n")[Number(m[1]) - 1]);
  process.exit(1);
}

// El arranque de Railway lleva el archivo completo; pasado el limite el
// contenedor no levanta ("Argument list too long").
const bytes = new TextEncoder().encode(src).length;
console.log("script del navegador: OK");
console.log("tamano del archivo:", bytes, "bytes");
if (bytes > 98000) { console.error("DEMASIADO GRANDE: por arriba de ~98 KB Railway no arranca"); process.exit(1); }
console.log("margen contra el limite:", 98000 - bytes, "bytes");
