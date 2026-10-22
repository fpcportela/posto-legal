/* Regras do Posto Legal: funções puras (sem DOM, sem rede, sem localStorage), usadas pelo protótipo
   web (window.Regras), pelos testes (testes/regras.test.js) e, depois, pelo app Expo (require). */
(function(raiz,fabrica){const R=fabrica();if(typeof module==="object"&&module.exports)module.exports=R;else raiz.Regras=R})(typeof self!=="undefined"?self:this,function(){
"use strict";
const soDig=s=>String(s||"").replace(/\D/g,"");
const nOuNulo=v=>v==null||v===""?null:Number(v);

/* ---------- abastecimento ---------- */
// Média pelo tanque cheio: km rodados desde o abastecimento anterior ÷ litros deste. Só vale com o tanque
// completado nos dois, e mede o combustível do posto ANTERIOR (é a ele que a média é atribuída).
function mediaKmL(atual,anterior){
  if(!atual||!anterior||!atual.cheio||!anterior.cheio)return null;
  const rod=atual.km-anterior.km;
  return rod>0&&atual.litros>0?rod/atual.litros:null;
}
// O último abastecimento do veículo (maior km) é o que espera avaliação no abastecimento seguinte.
function ultimoAbastecimento(abastecimentos,veiculoId){
  let u=null;
  for(const a of abastecimentos||[])if(a.veiculoId===veiculoId&&(!u||a.km>u.km))u=a;
  return u;
}
// No primeiro abastecimento de um veículo não há avaliação; a partir do segundo, a nota é obrigatória.
const precisaAvaliar=ultimo=>!!ultimo;
// Nota de 1 a 5 em meias estrelas (3,5; 4,5), a mesma regra do check do banco.
const notaValida=n=>typeof n==="number"&&n>=1&&n<=5&&n*2===Math.trunc(n*2);

/* ---------- cadastro e login ---------- */
function cpfValido(c){
  c=soDig(c);if(c.length!==11||/^(\d)\1+$/.test(c))return false;
  for(let t=9;t<11;t++){let s=0;for(let i=0;i<t;i++)s+=+c[i]*(t+1-i);if((s*10)%11%10!==+c[t])return false}
  return true;
}
// DDD + celular: 11 dígitos, e o terceiro é o 9 do celular.
const whatsValido=w=>{w=soDig(w);return w.length===11&&w[2]==="9"};
const senhaErro=(a,b)=>a.length<8||!/[A-Za-z]/.test(a)||!/\d/.test(a)?"A senha precisa ter pelo menos 8 caracteres, com letras e números.":a!==b?"As senhas não conferem.":"";

/* ---------- reputação do posto ---------- */
function agruparPorPosto(itens){
  const m=new Map();
  for(const i of itens){const l=m.get(i.postoId);if(l)l.push(i);else m.set(i.postoId,[i])}
  return m;
}
// its: avaliações de um posto. n conta só as que têm nota; precos guarda o último preço relatado por combustível.
function statsDoPosto(its){
  const rated=its.filter(i=>i.estrelas);
  const media=rated.length?rated.reduce((a,i)=>a+i.estrelas,0)/rated.length:null;
  const kml=its.filter(i=>i.kmL);
  const precos={};its.slice().sort((a,b)=>a.data.localeCompare(b.data)).forEach(i=>{if(i.preco&&i.comb)precos[i.comb]={preco:i.preco,data:i.data}});
  return {its,n:rated.length,media,kml,precos};
}
// Cor do marcador e do aviso, pelos limites dos "Alertas de reputação" da Garagem (cfg: {baixo, alto, min}).
function reputacao(st,cfg){
  if(!st.n)return {cls:"none",motivo:"sem-nota"};
  if(st.n<cfg.min)return {cls:"mid",motivo:"poucas"};
  if(st.media<=cfg.baixo)return {cls:"bad",motivo:"ruim"};
  if(st.media>=cfg.alto)return {cls:"good",motivo:"boa"};
  return {cls:"mid",motivo:"regular"};
}

/* ---------- distância ---------- */
// Haversine, em metros, entre [lat, lng].
function distM(a,b){const r=x=>x*Math.PI/180,h=Math.sin(r(b[0]-a[0])/2)**2+Math.cos(r(a[0]))*Math.cos(r(b[0]))*Math.sin(r(b[1]-a[1])/2)**2;return 2*6371e3*Math.asin(Math.sqrt(h))}

/* ---------- sincronização com o banco ---------- */
// Junta ao mapa (id → linha) as linhas novas ou alteradas e tira as apagadas. A busca repete uma janela
// de tempo, então a mesma linha pode voltar: só conta como mudança se for nova ou mais recente.
// Uma linha regravada depois de apagada (atualizado_em mais novo que o apagado_em) fica.
function mesclarLinhas(mapa,linhas,apagados,tabela){
  let n=0;
  for(const r of linhas){const a=mapa.get(r.id);if(a&&a.atualizado_em===r.atualizado_em)continue;mapa.set(r.id,r);n++}
  for(const x of apagados){
    if(x.tabela!==tabela)continue;
    const a=mapa.get(x.registro);
    if(a&&!(a.atualizado_em&&Date.parse(a.atualizado_em)>Date.parse(x.apagado_em))){mapa.delete(x.registro);n++}
  }
  return n;
}
// Maior data de mudança vista (relógio do servidor): a próxima busca começa dali.
function ultimaMudanca(linhas,apagados,desde){
  let m=desde?Date.parse(desde):-Infinity,s=desde||null;
  for(const r of linhas){const t=r.atualizado_em?Date.parse(r.atualizado_em):NaN;if(t>m){m=t;s=r.atualizado_em}}
  for(const x of apagados){const t=Date.parse(x.apagado_em);if(t>m){m=t;s=x.apagado_em}}
  return s;
}
// Linhas do banco → estruturas do app: postos por id, avaliações por usuário (em ordem de data, com o nome
// mais recente de cada um) e suspeitas por posto (em ordem de criação).
function montarRede({postos,aval,susp}){
  const P={},pub={},pubNome={},su={},porCampo=c=>(x,y)=>String(x[c]).localeCompare(String(y[c]));
  for(const r of postos.values())P[r.id]={nome:r.nome,cnpj:r.cnpj||undefined,bandeira:r.bandeira,cidade:r.cidade,uf:r.uf,endereco:r.endereco,lat:r.lat,lng:r.lng,criadoPor:r.criado_por,criadoEm:r.criado_em};
  for(const r of [...aval.values()].sort(porCampo("data"))){
    (pub[r.user_id]=pub[r.user_id]||[]).push({id:r.id,postoId:r.posto_id,comb:r.comb,preco:nOuNulo(r.preco),modelo:r.modelo,kmL:nOuNulo(r.km_l),estrelas:r.estrelas!=null?Number(r.estrelas):undefined,obs:r.obs||undefined,avaliadoEm:r.avaliado_em||undefined,data:r.data});
    if(r.nome)pubNome[r.user_id]=r.nome;
  }
  for(const r of [...susp.values()].sort(porCampo("criado_em")))(su[r.posto_id]=su[r.posto_id]||[]).push({id:r.id,uid:r.user_id,nome:r.nome,abastId:r.abastecimento_id,categoria:r.categoria,motivo:r.motivo,data:r.criado_em});
  return {postos:P,pub,pubNome,susp:su};
}

return {soDig,nOuNulo,mediaKmL,ultimoAbastecimento,precisaAvaliar,notaValida,cpfValido,whatsValido,senhaErro,agruparPorPosto,statsDoPosto,reputacao,distM,mesclarLinhas,ultimaMudanca,montarRede};
});
