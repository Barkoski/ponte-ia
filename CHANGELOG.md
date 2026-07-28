# Changelog

Todas as mudanças relevantes do Ponte IA são registradas aqui.

## 1.1.0 — 2026-07-28

### Segurança e privacidade

- As chaves salvas não são mais devolvidas ao processo de interface.
- O app se recusa a salvar chaves sem a criptografia segura do sistema.
- Sandbox do Electron ativado, origem das chamadas IPC validada e permissões da
  sessão negadas por padrão.
- Navegação interna e abertura de links externos restringidas a destinos HTTPS.
- Chamadas da OpenAI usam `store: false`.
- Respostas de um modelo são identificadas para o outro como conteúdo não
  confiável, reduzindo o risco de injeção de prompt entre modelos.

### Correções

- O teste de integração agora usa um perfil temporário e não toca mais nos dados
  reais do usuário.
- Interrupções preservam respostas parciais sem continuar automaticamente um
  debate ou uma síntese.
- Streams SSE aceitam LF e CRLF e reportam eventos inválidos e erros do provedor.
- Chamadas têm limite de tempo e IDs de execução resistentes a colisões.
- Histórico e configurações são gravados de forma atômica e com limites de
  tamanho.
- Modelos Claude sem suporte a controles avançados recebem uma nova tentativa
  compatível após erro explícito de parâmetro.

### Melhorias

- PDFs são enviados também à OpenAI, além da Anthropic.
- Limites de anexos: 5 arquivos, 20 MB por arquivo e 40 MB por mensagem.
- Contagem de tokens exibida e incluída na exportação quando a API a informa.
- Avisos de compatibilidade e respostas parciais aparecem na interface.
- CI e publicação automatizada dos executáveis para Windows.

## 1.0.0 — 2026-07-27

- Primeira versão pública.
