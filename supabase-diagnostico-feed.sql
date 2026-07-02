-- ============================================================
-- Diagnóstico e correção do bug "post some do feed"
-- Rode cada bloco manualmente no SQL Editor do Supabase.
-- Nada aqui é destrutivo por padrão: os UPDATEs vêm comentados
-- e o bloco de reparo pede confirmação visual antes de aplicar.
-- ============================================================

-- 1) INSPEÇÃO: policies de RLS na tabela relatorios (e tabelas relacionadas)
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where tablename in ('relatorios', 'rdo_fotos', 'rdo_usuarios', 'rdo_perfis', 'rdo_seguidores');

-- 2) INSPEÇÃO: RLS está habilitado nessas tabelas?
select relname, relrowsecurity, relforcerowsecurity
from pg_class
where relname in ('relatorios', 'rdo_fotos', 'rdo_usuarios', 'rdo_perfis', 'rdo_seguidores');

-- 3) INSPEÇÃO: triggers na tabela relatorios (para confirmar que nada do
--    projeto Futbola ficou "grudado" aqui por engano)
select tgname, tgrelid::regclass as tabela, tgenabled, pg_get_triggerdef(oid) as definicao
from pg_trigger
where tgrelid = 'public.relatorios'::regclass and not tgisinternal;

-- 4) INSPEÇÃO: funções cujo nome cita "relatorio", "post", "feed" ou "futbola"
select proname, pg_get_functiondef(oid) as definicao
from pg_proc
where proname ilike any (array['%relatorio%','%post%','%feed%','%futbola%']);

-- 5) INSPEÇÃO: colunas atuais da tabela relatorios (confirmar schema real)
select column_name, data_type, column_default, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'relatorios'
order by ordinal_position;

-- 6) DIAGNÓSTICO CONFIRMADO NESTA SESSÃO: posts reais (com descrição) que
--    nasceram com usuario_login vazio. Isso aconteceu no CLIENTE (index.html
--    lia sessionStorage direto em vez da cadeia robusta de sessão) e não tem
--    relação com RLS/trigger/policy. Ainda assim, é sempre bom confirmar que
--    não há trigger sobrescrevendo o campo — ver blocos 3 e 4 acima.
select id, usuario_login, data_registro, hora_registro, created_at,
       left(descricao_original, 80) as descricao_resumo
from public.relatorios
where coalesce(usuario_login, '') = ''
  and coalesce(descricao_original, '') <> ''
order by created_at;

-- 7) REPARO -- JÁ APLICADO em 2026-07-01 -------------------------------------
-- As 13 linhas do bloco 6 tinham TODAS o mesmo par empresa_id/obra_id
-- (Marka / Obra do Rebaixamento dos Pátios), idêntico ao dos outros posts
-- confirmados do usuário "elias" -- confirmação forte, não só estilo de texto.
-- Já rodei o UPDATE abaixo via REST (13 linhas afetadas, IDs no histórico da
-- conversa). Mantido aqui apenas como registro/idempotente para reaplicar se
-- surgir alguma linha nova nesse mesmo padrão.
--
-- update public.relatorios
-- set usuario_login = 'elias'
-- where coalesce(usuario_login, '') = ''
--   and coalesce(descricao_original, '') <> '';

-- 8) TRAVA DE SEGURANÇA (OPCIONAL, REVERSÍVEL) ------------------------------
-- Impede que o bug volte a acontecer mesmo se algum outro ponto do app
-- esquecer de resolver o login corretamente. Reversível com o DROP no final.
--
-- alter table public.relatorios
--   add constraint relatorios_usuario_login_nao_vazio
--   check (usuario_login is not null and length(trim(usuario_login)) > 0)
--   not valid; -- not valid = não re-valida linhas antigas, só passa a valer para novos inserts/updates
--
-- Para reverter:
-- alter table public.relatorios drop constraint relatorios_usuario_login_nao_vazio;

-- ============================================================
-- ACHADO DE SEGURANÇA (fora do escopo do bug do feed, mas crítico)
-- A tabela rdo_usuarios expõe a coluna "senha" em texto puro e é legível
-- via a anon/publishable key embutida no index.html — ou seja, qualquer
-- pessoa que abrir o código-fonte da página consegue ler login+senha de
-- TODOS os usuários direto do Supabase, sem precisar de RLS bypass nenhum.
-- Isso não foi causado pelo incidente de sábado; é uma falha estrutural
-- pré-existente. Recomendação (não aplicada aqui, decisão do time):
--   a) nunca devolver "senha" em select * — criar uma view sem essa coluna
--      e apontar o app pra ela, OU
--   b) adicionar RLS em rdo_usuarios negando SELECT para o role anon,
--      movendo a validação de login para uma Edge Function/RPC com
--      service role, que compara o hash da senha server-side.
-- Qualquer uma das duas exige mudar o fluxo de login do app — avise antes
-- de aplicar, pois pode quebrar o login atual se não for coordenado.
