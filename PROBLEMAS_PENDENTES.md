# InstaRDO — Diretório de Problemas Pendentes
> Arquivo de briefing para a próxima sessão do Claude.
> Arquivo único: `C:\Users\coron\OneDrive\Área de Trabalho\InstaRDO_DEPLOY_NETLIFY\index.html` (~15 000 linhas, vanilla JS)

---

## REGRAS DE ARQUITETURA (NUNCA VIOLAR)

| Regra | Detalhe |
|---|---|
| `rdo_registros` é alias JS | `SB_TABLE['rdo_registros'] = 'relatorios'`. Nunca usar `/rest/v1/rdo_registros` diretamente |
| REST direto = `/rest/v1/relatorios` | Para queries diretas use sempre o nome real da tabela |
| `sbRequest` retorna JSON parsed | Nunca chamar `.json()` no resultado — já vem parseado |
| `sbPatchById('relatorios',…)` é destrutivo | Chama `toSbRelatorio()` que zera campos. Para PATCH parcial usar `sbRequest('/rest/v1/relatorios?id=eq.${id}', {method:'PATCH', body: JSON.stringify(soOsCamposQueQuero)})` |
| Não recriar tabelas existentes | `rdo_racs`, `rdo_inspecoes_seguranca`, `rdo_inspecao_evidencias`, `rdo_configuracoes_visuais` já existem |
| Não alterar `gerarRelatorio()`, `gerarPDFReal()`, PDF filters, formato normal do post (1:1) | Módulo segurança é isolado |

---

## MÓDULO DE SEGURANÇA — CONTEXTO GERAL

- Tabelas: `relatorios` (feed), `rdo_fotos` (fotos), `rdo_inspecoes_seguranca` (inspeção), `rdo_inspecao_evidencias` (evidências)
- Posts de inspeção têm `tipo_postagem = 'inspecao_seguranca'` e `inspecao_id = inspecaoId`
- A foto do card (16:9) é gerada no canvas `#seg-final-canvas` e uploadada para `fotos-rdo/seguranca/${inspecaoId}/card.jpg`
- Função de publicação: `publicarInspecaoNoFeed(inspecao, cardBlob, cardFinalUrl, cardStoragePath)` (linha ~14795)
- Função de salvar: `salvarInspecaoSeguranca()` (linha 14913)
- Netlify function: `netlify/functions/inspecao-seguranca.mjs` (ações: `analisar_inspecao_seguranca`, `gerar_descricao_inspecao`)

---

## PROBLEMA 1 — FOTO DO POST NÃO APARECE NO FEED

### Sintoma
Post de inspeção de segurança aparece no feed com texto/dados corretos mas **sem imagem**.

### O que já foi feito nesta sessão
- `sbSelect('rdo_fotos')` agora mapeia via `fromSbFoto` (linha 2785):
  ```js
  // ANTES:
  if (store === 'fotos')
  // DEPOIS (já corrigido):
  if (store === 'fotos' || store === 'rdo_fotos')
      return (rows || []).map(fromSbFoto);
  ```

### Pipeline de renderização (para entender o fluxo)
```
loadFeed()
  → loadFeedData()
      → sbSelect('rdo_fotos')  [linha 5347] → retorna fotos mapeadas (fromSbFoto)
      → sbSelect('relatorios') [linha 5370] → internamente também chama fromSbFoto
                                             → define rr.fotoIds = fotosPorRegistro[rr.id]
  → attachPhotosToPosts(posts, fotosRaw)
      → fotosCombinadas = mergeById(STATE.fotos, fotosRaw)
      → reg.fotos = dedupeFotosForRegistro(reg, fotosCombinadas)
  → renderFeedPosts(posts)
      → getRegistroMainPhoto(reg)   [usa STATE.fotos + reg.fotos]
      → fotosHtml: urls.map(f => getPhotoUrl(f))
```

### Causas prováveis ainda não confirmadas
1. **`cardFinalUrl` vazia no momento da inserção** — Se o canvas `#seg-final-canvas` não tinha conteúdo quando `salvarInspecaoSeguranca()` rodou, `cardBlob` é null, `cardFinalUrl` fica `''`, e a foto não é inserida em `rdo_fotos`. O usuário precisa ter passado pela etapa de preview (clicado "Pré-visualizar card") antes de salvar.

2. **Linha em `rdo_fotos` não existe** — Verificar no Supabase se há uma linha em `rdo_fotos` com `registro_id` igual ao `id` do post de segurança.

3. **URL pública inacessível** — A URL `storage/v1/object/public/fotos-rdo/seguranca/…` pode retornar 403 se o bucket não estiver configurado como público no Supabase.

4. **Race condition no `loadFeed`** — O `setTimeout(loadFeed, 300)` pode disparar antes do insert em `rdo_fotos` ser confirmado pelo Supabase.

### Como diagnosticar (no console do browser)
```js
// Verificar STATE.fotos
STATE.fotos.filter(f => f.storagePath?.includes('seguranca'))
// Verificar se o post tem fotoIds
STATE.relatorios.filter(r => r.tipoPostagem === 'inspecao_seguranca').map(r => ({id: r.id, fotoIds: r.fotoIds}))
// Verificar se a URL carrega
fetch('URL_DO_CARD').then(r => console.log(r.status))
```

### O que o próximo Claude deve fazer
1. Verificar se o usuário passou pela etapa de preview antes de salvar (o canvas precisa ter conteúdo)
2. Se necessário, forçar `generateInspectionCardCanvas()` dentro de `salvarInspecaoSeguranca()` antes de fazer `toBlob`, garantindo que o canvas tenha conteúdo mesmo sem preview
3. Garantir que a foto da **original** (não só o card) seja linkada ao post — `fotoOriginalUrl` já é salva em `rdo_inspecoes_seguranca.foto_original_url`, mas também pode ser útil publicar a foto original no feed (mais simples, sem depender do canvas)
4. Adicionar log de diagnóstico em `publicarInspecaoNoFeed` para confirmar que `fotoId` foi retornado após o INSERT em `rdo_fotos`

### Localização no código
| Função | Linha aprox. |
|---|---|
| `salvarInspecaoSeguranca` | 14913 |
| `generateInspectionCardCanvas` | 14579 |
| `_uploadInspectionAsset` | 14782 |
| `publicarInspecaoNoFeed` | 14795 |
| `sbSelect` (fix do mapeamento) | 2785 |
| `fromSbFoto` | 2657 |
| `dedupeFotosForRegistro` | 2958 |
| `attachPhotosToPosts` | 5392 |
| `renderFeedPosts` → fotosHtml | 5565 |

---

## PROBLEMA 2 — IA DA INSPEÇÃO DE SEGURANÇA NÃO ATIVA

### Sintoma
Botão "Analisar com IA" (⭐ `btn-analisar-ia`) no formulário de inspeção ou não aparece, ou ao clicar exibe "Sem permissão para IA de Inspeção."

### Fluxo da IA
```
btn-analisar-ia → analisarInspecaoComIA()  [linha 14410]
  → canUseInspectionAI()                   [linha 14168]
      → se login === MESTRE_LOGIN → true
      → senão: usuario.permissoes.includes('ia_inspecao') → true/false
  → fetch('/.netlify/functions/inspecao-seguranca', { action: 'analisar_inspecao_seguranca', image: base64, racs, ... })
  → exibe resultado: rac sugerido, evidências, confianças

btn-gerar-desc → gerarDescricaoInspecaoComIA()  [linha 14535]
  → fetch('/.netlify/functions/inspecao-seguranca', { action: 'gerar_descricao_inspecao', ... })
```

### Possíveis causas
1. **Permissão `ia_inspecao` não concedida ao usuário** — O mestre pode conceder em Gerenciamento → editar usuário → marcar "IA Inspeção de Segurança" (checkbox `edit-perm-ia_inspecao`). Para o MESTRE_LOGIN o acesso é automático.

2. **Netlify function não deployada** — A função `netlify/functions/inspecao-seguranca.mjs` precisa estar deployada. Em produção no Netlify, verificar se a função aparece no dashboard. Localmente, usar `netlify dev` para que `/.netlify/functions/…` funcione.

3. **`OPENAI_API_KEY` não configurada no Netlify** — A função usa `process.env.OPENAI_API_KEY`. Se não estiver setada, retorna HTTP 500 com `"OPENAI_API_KEY nao configurada."` Verificar em Netlify → Site settings → Environment variables.

4. **Modelo OpenAI incorreto** — A função usa `gpt-4o-mini` por padrão (com visão). Verificar se o modelo está disponível na conta OpenAI.

5. **Foto não carregada antes de clicar** — `analisarInspecaoComIA()` verifica `INSPECAO_STATE.fotoPreviewUrl` e mostra erro "Adicione uma foto primeiro." — o usuário precisa ter adicionado foto na etapa 2.

6. **`getCurrentUserLogin()` retorna string vazia** — O check `normalizeLogin(login) === MESTRE_LOGIN` falha. Verificar no console: `getCurrentUserLogin()` e `MESTRE_LOGIN`.

### O que o próximo Claude deve fazer
1. Confirmar se é problema de permissão (fácil fix: mestre edita usuário e marca `ia_inspecao`) ou de deploy (Netlify function não disponível)
2. Se for problema de permissão, verificar `normalizePermissoes` e como `ia_inspecao` é lida/salva para o usuário mestre
3. Se `canUseInspectionAI()` retorna false para o mestre, debugar `getCurrentUserLogin()` vs `MESTRE_LOGIN` no console
4. Se a Netlify function está retornando erro, adicionar melhor tratamento de erro e log em `analisarInspecaoComIA` para expor a mensagem de erro ao usuário

### Localização no código
| Função/Elemento | Linha aprox. |
|---|---|
| `canUseInspectionAI` | 14168 |
| `analisarInspecaoComIA` | 14410 |
| `gerarDescricaoInspecaoComIA` | 14535 |
| `btn-analisar-ia` (HTML) | 1547 |
| `btn-gerar-desc` (HTML) | 1581 |
| `new-perm-ia_inspecao` (checkbox novo user) | 1959 |
| `edit-perm-ia_inspecao` (checkbox editar user) | 2260 |
| `USER_PERMISSIONS` | 2677 |
| Netlify function | `netlify/functions/inspecao-seguranca.mjs` |

---

## OUTRAS CORREÇÕES FEITAS NESTA SESSÃO (não mexer)

| O que foi feito | Linha |
|---|---|
| `sbSelect('rdo_fotos')` agora usa `fromSbFoto` | 2785 |
| `executarCompartilhar` compartilha foto original (sem canvas card) | 5779 |
| `fromSbRelatorio` inclui `tipoPostagem`, `inspecaoId` | 2675 |
| `toSbRelatorio` inclui `tipo_postagem`, `inspecao_id` | 2676 |
| `publicarInspecaoNoFeed` usa `/rest/v1/relatorios` (não alias) | 14795 |
| INSERT em `rdo_fotos` sem ID customizado (Supabase gera UUID) | 14795 |
| PATCH de `foto_ids` usa `sbRequest` direto (não `sbPatchById`) | 14795 |
| `gerarRelatorio()` exclui posts de segurança | 9737 |
| Histórico mostra badge "🦺 Segurança" | ~9194 |
| `RAC_CATALOG_DEFAULT` corrigido para 13 RACs oficiais Vale + N/A | 14109 |

---

## SQL NECESSÁRIO (usuário deve rodar no Supabase se ainda não rodou)

```sql
ALTER TABLE public.relatorios ADD COLUMN IF NOT EXISTS tipo_postagem TEXT;
CREATE INDEX IF NOT EXISTS idx_relatorios_tipo_postagem ON public.relatorios (tipo_postagem);
ALTER TABLE public.relatorios ADD COLUMN IF NOT EXISTS inspecao_id TEXT;
CREATE INDEX IF NOT EXISTS idx_relatorios_inspecao_id ON public.relatorios (inspecao_id);
```
