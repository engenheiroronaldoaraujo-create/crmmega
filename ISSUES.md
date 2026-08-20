# Issues conhecidas

> Placeholder de tracking enquanto o repo não está em um remoto GitHub. Quando
> houver remote, converter cada entrada em uma issue real (`gh issue create`).

## TS strict: `body` possivelmente `undefined` em `api/bootstrap.ts` (`requireBody`)

- **Status:** aberta — **pré-existente**, fora do escopo das correções do Prompt 4.
- **Severidade:** 🟡 — `tsc --noEmit --strict` falha; um build strict na Vercel
  reclamaria. Não bloqueia os runtimes que de fato exercitam o caminho feliz.
- **Arquivo / local:** `api/bootstrap.ts`, função `requireBody`, ~linha 232.
- **Erro:** `error TS18048: 'body' is possibly 'undefined'.`
- **Causa:** `requireBody(body: BootstrapBody | undefined)` valida os campos com
  `for (...) if (!body?.[key]) throw ...`. O optional-chaining **não estreita** o
  tipo de `body` para não-`undefined`, então o `return { ...body,
  vercel_project_id: body.vercel_project_id ?? ... }` acessa `body` possivelmente
  `undefined`.
- **Repro:**
  ```bash
  npx tsc --noEmit --skipLibCheck --strict --target ES2022 --module ESNext \
    --moduleResolution bundler --lib ES2022,DOM,DOM.Iterable --types node \
    api/bootstrap.ts
  ```
- **Fix sugerido (juntar com outras correções de TS strict numa próxima rodada):**
  guard explícito antes do loop — `if (!body) throw new Error('Body ausente.');`
  — ou `const b: BootstrapBody = body ?? {};` e validar/retornar sobre `b`.
- **Por que não foi corrigido agora:** decisão do autor de manter o escopo
  restrito às 4 correções do Prompt 4; este item é anterior a elas.
- **Descoberto em:** type-check dos `api/*.ts` durante as correções do Prompt 4.
