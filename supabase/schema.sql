-- POSTO LEGAL — banco no Supabase
-- Rode inteiro no SQL Editor do projeto (pode rodar de novo: só cria o que falta).
-- Regras de acesso (RLS):
--   * cada usuário lê e altera só o próprio perfil, garagem e abastecimentos;
--   * postos e avaliações são da rede: todo usuário logado lê; cada um grava só o que é seu;
--   * eventos de uso: qualquer visitante grava; só administradores leem;
--   * administradores (profiles.is_admin) leem tudo.

create extension if not exists pgcrypto;

-- ---------- perfis (dados do cadastro) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nome text not null,
  cpf text not null unique check (cpf ~ '^[0-9]{11}$'),
  email text not null,
  whats text not null check (whats ~ '^[0-9]{11}$'),
  status text not null default 'pendente' check (status in ('pendente','confirmado')),
  lgpd_em timestamptz,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  confirmado_em timestamptz,
  is_admin boolean not null default false
);

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false)
$$;

-- o usuário não pode se promover a administrador (o SQL Editor, sem usuário logado, pode)
create or replace function public.trava_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if tg_op = 'INSERT' then new.is_admin := false;
    else new.is_admin := old.is_admin;
    end if;
  end if;
  new.atualizado_em := now();
  return new;
end $$;
drop trigger if exists trava_admin on public.profiles;
create trigger trava_admin before insert or update on public.profiles
  for each row execute function public.trava_admin();

-- login por CPF: devolve o e-mail da conta para entrar com senha
create or replace function public.email_do_login(ident text) returns text
language sql stable security definer set search_path = public as $$
  select email from public.profiles
  where cpf = regexp_replace(ident, '\D', '', 'g') or lower(email) = lower(trim(ident))
  limit 1
$$;
-- cadastro: avisa se CPF ou e-mail já estão em uso (sem expor dados)
create or replace function public.cadastro_em_uso(p_cpf text, p_email text) returns text
language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from public.profiles where cpf = p_cpf and id is distinct from auth.uid()) then 'cpf'
    when exists (select 1 from public.profiles where lower(email) = lower(p_email) and id is distinct from auth.uid()) then 'email'
  end
$$;
grant execute on function public.email_do_login(text) to anon, authenticated;
grant execute on function public.cadastro_em_uso(text, text) to anon, authenticated;

-- ---------- postos (rede) ----------
create table if not exists public.postos (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  bandeira text,
  cidade text,
  uf text,
  endereco text,
  lat double precision,
  lng double precision,
  criado_por uuid default auth.uid() references auth.users(id) on delete set null,
  criado_em timestamptz not null default now()
);

-- Postos do cadastro da ANP ficam em arquivos do site (prototipo/anp/) e só entram aqui no
-- primeiro abastecimento; o CNPJ evita duplicar o mesmo posto.
alter table public.postos add column if not exists cnpj text;
create unique index if not exists postos_cnpj on public.postos(cnpj) where cnpj is not null;

-- ---------- garagem (veículos e configuração dos alertas) ----------
create table if not exists public.garagem (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  dados jsonb not null default '{}'::jsonb,
  atualizado_em timestamptz not null default now()
);

-- ---------- abastecimentos (privados) ----------
create table if not exists public.abastecimentos (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  veiculo_id text,
  veiculo_modelo text,
  posto_id uuid references public.postos(id) on delete set null,
  posto_nome text,
  km numeric,
  comb text,
  preco numeric,
  total numeric,
  litros numeric,
  cheio boolean,
  media numeric,
  estrelas numeric(2,1),
  obs text,
  km_l numeric,
  avaliado_em timestamptz,
  data timestamptz not null default now()
);
create index if not exists abastecimentos_user on public.abastecimentos(user_id);

-- ---------- avaliações (públicas na rede, uma por abastecimento) ----------
create table if not exists public.avaliacoes (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nome text,
  posto_id uuid references public.postos(id) on delete cascade,
  comb text,
  preco numeric,
  modelo text,
  km_l numeric,
  estrelas numeric(2,1),
  obs text,
  avaliado_em timestamptz,
  data timestamptz not null default now()
);
create index if not exists avaliacoes_posto on public.avaliacoes(posto_id);

-- Nota de 1 a 5 em meias estrelas (3,5; 4,5). Bancos criados antes guardavam inteiro (smallint):
-- converte a coluna e troca a regra. Pode rodar de novo.
alter table public.abastecimentos alter column estrelas type numeric(2,1);
alter table public.avaliacoes drop constraint if exists avaliacoes_estrelas_check;
alter table public.avaliacoes alter column estrelas type numeric(2,1);
alter table public.avaliacoes add constraint avaliacoes_estrelas_check
  check (estrelas between 1 and 5 and estrelas * 2 = trunc(estrelas * 2));

-- ---------- eventos de uso ----------
create table if not exists public.eventos (
  id bigint generated always as identity primary key,
  user_id uuid default auth.uid(),
  sessao text,
  tipo text not null,
  dados jsonb,
  tela text,
  agente text,
  criado_em timestamptz not null default now()
);
create index if not exists eventos_tipo_data on public.eventos(tipo, criado_em);

-- ---------- RLS ----------
alter table public.profiles enable row level security;
alter table public.postos enable row level security;
alter table public.garagem enable row level security;
alter table public.abastecimentos enable row level security;
alter table public.avaliacoes enable row level security;
alter table public.eventos enable row level security;

drop policy if exists perfil_ler on public.profiles;
drop policy if exists perfil_criar on public.profiles;
drop policy if exists perfil_alterar on public.profiles;
create policy perfil_ler on public.profiles for select to authenticated using (id = auth.uid() or public.is_admin());
create policy perfil_criar on public.profiles for insert to authenticated with check (id = auth.uid());
create policy perfil_alterar on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists postos_ler on public.postos;
drop policy if exists postos_criar on public.postos;
drop policy if exists postos_alterar on public.postos;
create policy postos_ler on public.postos for select to authenticated using (true);
create policy postos_criar on public.postos for insert to authenticated with check (criado_por = auth.uid());
create policy postos_alterar on public.postos for update to authenticated using (criado_por = auth.uid() or public.is_admin());

drop policy if exists garagem_dono on public.garagem;
drop policy if exists garagem_admin on public.garagem;
create policy garagem_dono on public.garagem for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy garagem_admin on public.garagem for select to authenticated using (public.is_admin());

drop policy if exists abast_dono on public.abastecimentos;
drop policy if exists abast_admin on public.abastecimentos;
create policy abast_dono on public.abastecimentos for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy abast_admin on public.abastecimentos for select to authenticated using (public.is_admin());

drop policy if exists aval_ler on public.avaliacoes;
drop policy if exists aval_dono on public.avaliacoes;
create policy aval_ler on public.avaliacoes for select to authenticated using (true);
create policy aval_dono on public.avaliacoes for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists eventos_gravar on public.eventos;
drop policy if exists eventos_admin on public.eventos;
create policy eventos_gravar on public.eventos for insert to anon, authenticated
  with check (user_id is null or user_id = auth.uid());
create policy eventos_admin on public.eventos for select to authenticated using (public.is_admin());

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.profiles, public.postos, public.garagem, public.abastecimentos, public.avaliacoes to authenticated;
grant insert on public.eventos to anon, authenticated;
grant select on public.eventos to authenticated;

-- ---------- suspeitas de fraude (relatos públicos na rede) ----------
-- Marcadas no abastecimento e gravadas no posto em que ele foi feito. Todo usuário logado lê;
-- cada um grava e apaga só os próprios; o administrador apaga relatos abusivos.
create table if not exists public.suspeitas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nome text,
  posto_id uuid not null references public.postos(id) on delete cascade,
  abastecimento_id text,
  categoria text not null,
  motivo text not null check (char_length(motivo) between 10 and 500),
  criado_em timestamptz not null default now()
);
create index if not exists suspeitas_posto on public.suspeitas(posto_id);
alter table public.suspeitas enable row level security;
drop policy if exists susp_ler on public.suspeitas;
drop policy if exists susp_criar on public.suspeitas;
drop policy if exists susp_apagar on public.suspeitas;
create policy susp_ler on public.suspeitas for select to authenticated using (true);
create policy susp_criar on public.suspeitas for insert to authenticated with check (user_id = auth.uid());
create policy susp_apagar on public.suspeitas for delete to authenticated using (user_id = auth.uid() or public.is_admin());
grant select, insert, delete on public.suspeitas to authenticated;

-- ---------- visões para análise (só administradores enxergam linhas) ----------
create or replace view public.uso_por_dia with (security_invoker = on) as
  select date_trunc('day', criado_em at time zone 'America/Sao_Paulo')::date as dia,
         tipo, count(*) as eventos, count(distinct coalesce(user_id::text, sessao)) as pessoas
  from public.eventos group by 1, 2 order by 1 desc, 3 desc;
grant select on public.uso_por_dia to authenticated;

-- Depois de criar sua conta no app, torne-se administrador (troque o e-mail):
-- update public.profiles set is_admin = true where email = 'seu-email@exemplo.com';
