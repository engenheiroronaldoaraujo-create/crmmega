# Customizations

Este diretório é o local **único e seguro** para customizações de código que
você quer fazer na sua instância sem causar conflitos com atualizações do
upstream.

## Por que existe

Quando você puxa atualizações do upstream, o Git tenta
mesclar as mudanças do projeto principal com seu código local. Se você
editar arquivos fora deste diretório, vai conflitar quando puxar
atualizações.

**Regra simples:** o upstream nunca edita arquivos dentro de
`src/customizations/`. Tudo aqui é seu.

## Como usar

- Crie hooks, componentes, helpers próprios aqui:
  ```
  src/customizations/
  ├── hooks/
  │   └── useMyCustomThing.ts
  ├── components/
  │   └── MyCustomBadge.tsx
  └── lib/
      └── meuHelper.ts
  ```

- Importe-os no resto da aplicação normalmente:
  ```ts
  import { useMyCustomThing } from '@/customizations/hooks/useMyCustomThing';
  import { MyCustomBadge } from '@/customizations/components/MyCustomBadge';
  ```

- Para sobrescrever um componente do projeto, copie a versão atual para
  `src/customizations/` e importe daqui em vez do original. Lembre-se que
  esse fork manual deixa de receber atualizações do upstream — pesar se
  vale a pena.

## Limites

Customizações que exigem editar arquivos de domínio (ex.: alterar lógica de
uma Edge Function existente, mudar comportamento de um componente core
como `InboxPage` ou de uma migration aplicada) **não cabem aqui** — vão
precisar de merge manual quando atualizar.

Para essas, recomendado: abra issue ou PR no upstream sugerindo a
customização como feature opcional.

## Convenção de imports

O alias `@/customizations` aponta para esta pasta. Já está configurado em
`tsconfig.app.json` via `@/* → src/*`. Não precisa de configuração extra.
