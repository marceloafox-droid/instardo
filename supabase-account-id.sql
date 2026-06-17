-- Serial interno estavel para usuarios do InstaRDO.
-- Rode no Supabase SQL Editor uma vez.
-- Ele nao troca login, nome ou senha; apenas cria/preenche account_id.

create extension if not exists pgcrypto;

alter table public.rdo_usuarios
add column if not exists account_id text;

update public.rdo_usuarios
set account_id = 'acct_' || replace(gen_random_uuid()::text, '-', '')
where account_id is null or trim(account_id) = '';

alter table public.rdo_usuarios
alter column account_id set not null;

create unique index if not exists rdo_usuarios_account_id_key
on public.rdo_usuarios(account_id);

-- Opcional: se sua tabela de perfis tambem existir, deixa o mesmo serial la.
alter table public.rdo_perfis
add column if not exists account_id text;

update public.rdo_perfis p
set account_id = u.account_id
from public.rdo_usuarios u
where lower(p.login) = lower(u.login)
  and (p.account_id is null or trim(p.account_id) = '');
