# Política de Privacidade — Redmine Notificações

**Última atualização:** 07 de julho de 2026

## Resumo

A extensão "Redmine Notificações" **não coleta, armazena em servidores externos nem compartilha dados pessoais dos usuários**.

## Dados armazenados localmente

A extensão armazena as seguintes informações exclusivamente no navegador do usuário (via `chrome.storage`):

- **URL do Redmine** — endereço do servidor configurado pelo usuário
- **API Key** — chave de autenticação fornecida voluntariamente pelo usuário
- **Preferências** — intervalo de verificação, tipos de notificação habilitados
- **Estado das demandas** — cache temporário para detectar mudanças entre verificações
- **Lista de favoritos** — IDs das demandas marcadas como favoritas

Esses dados nunca saem do navegador do usuário, exceto para comunicação direta com o servidor Redmine configurado.

## Comunicação de rede

A extensão realiza requisições HTTP exclusivamente para o servidor Redmine configurado pelo usuário, utilizando a API Key fornecida. **Nenhum dado é enviado a servidores de terceiros, serviços de analytics ou qualquer outro destino.**

## Coleta de dados

- Não coletamos informações de identificação pessoal
- Não coletamos histórico de navegação
- Não coletamos dados de localização
- Não utilizamos cookies de rastreamento
- Não integramos serviços de analytics ou publicidade

## Compartilhamento de dados

Não vendemos, transferimos ou compartilhamos quaisquer dados do usuário com terceiros.

## Alterações nesta política

Eventuais alterações serão publicadas neste mesmo documento no repositório do projeto.

## Contato

Em caso de dúvidas, abra uma issue no repositório: https://github.com/joaojvja/RedmineNotificacoes/issues
