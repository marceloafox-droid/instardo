-- InstaRDO - complemento minimo para posts de Inspecao de Seguranca no feed
-- Rode no SQL Editor do Supabase se ainda nao tiver estas colunas/indice.

alter table public.relatorios
  add column if not exists tipo_postagem text;

alter table public.relatorios
  add column if not exists inspecao_id text;

create unique index if not exists idx_relatorios_inspecao_unica
  on public.relatorios (inspecao_id)
  where inspecao_id is not null;

-- Conferencia de tipos usados pelo app. Nao altera PKs.
select table_name, column_name, data_type, udt_name
from information_schema.columns
where table_schema = 'public'
  and table_name in ('relatorios', 'rdo_fotos')
  and column_name in ('id', 'registro_id', 'tipo_postagem', 'inspecao_id')
order by table_name, column_name;
