# Segurança

## Relatar uma vulnerabilidade

Não abra uma issue pública com chaves, conversas ou detalhes que permitam
explorar uma falha. Use o recurso **Private vulnerability reporting** na aba
Security do repositório, se disponível.

Se esse canal não estiver habilitado, abra uma issue sem dados sensíveis pedindo
um canal privado de contato.

Inclua a versão do Ponte IA, a versão do Windows, passos mínimos para reproduzir
e o impacto observado. Nunca inclua chaves de API reais.

## Modelo de segurança

- As chaves são protegidas pelo `safeStorage` do Electron no perfil do usuário.
- Chaves já salvas não são enviadas de volta à interface.
- Conversas ficam localmente no perfil do aplicativo, mas mensagens e anexos
  são enviados às APIs selecionadas para gerar respostas.
- Os executáveis publicados ainda não têm assinatura de código.

Somente a versão mais recente recebe correções de segurança.
