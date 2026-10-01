# Portafolio cripto (privado)

Apartado privado de Ray para seguir sus posiciones de cripto y acciones:
precios en vivo, senal de compra de 5 puntos, velas con sus compras (B) y
ventas (S), movimientos de capital por cartera y evolucion diaria de la cuenta.

Un solo archivo (`index.ts`) que corre con Bun y se sirve en Railway.

## Como corre

- **Runtime:** Bun. Arranque: `bun run index.ts`.
- **Datos:** un volumen de Railway montado en `/data` (`portafolio.json`).
  Ahi viven las posiciones, los movimientos y la foto diaria de la cuenta.
  El codigo NO trae el historico: si el volumen se pierde, el respaldo de la
  semilla original esta en los documentos del proyecto de Claude.
- **Acceso:** PIN en la variable `PORTAFOLIO_PIN`. El servidor valida el PIN,
  responde con una cookie firmada (HttpOnly, Secure) y **todas** las rutas de
  `/api/*` exigen esa cookie. La pagina no trae ningun dato embebido.
- **Precios:** CoinGecko para cripto (CoinPaprika de respaldo) y Yahoo Finance
  para acciones. Velas de Binance, con MEXC y Yahoo de respaldo.

## Variables de entorno

| Variable | Para que sirve |
|---|---|
| `PORTAFOLIO_PIN` | PIN de acceso. Sin esto nadie entra. |
| `PORTAFOLIO_DIR` | Carpeta del volumen. Por defecto `/data`. |
| `COINGECKO_API_KEY` | Opcional. Sube el limite de peticiones de CoinGecko. |

## Antes de hacer push

```bash
bun run check
```

Esto evalua la plantilla `PAGE` igual que lo hace Bun y le pasa el parser al
`<script>` resultante. **Hazlo siempre.** Toda la pagina va dentro de un
template literal, asi que un `\n` escrito de mas dentro de un string de JS se
convierte en un salto de linea real, rompe el script completo y la pagina queda
muerta sin dar ningun error visible: el PIN deja de responder. Ya paso una vez.
Escribe `\\n` cuando quieras un salto de linea en un mensaje.

El script tambien avisa del tamano del archivo. Eso importaba cuando esto vivia
como Railway Function (el codigo viajaba dentro del comando de arranque y arriba
de ~98 KB el contenedor no levantaba). Desde el repo ese limite ya no aplica,
pero el aviso se queda como referencia.

## Estructura

```
index.ts              todo: servidor, API, HTML, CSS y JS del navegador
scripts/verificar.ts  revisa la pagina servida antes de publicar
railway.json          build y arranque en Railway
```
