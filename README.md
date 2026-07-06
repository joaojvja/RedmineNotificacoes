# 📋 Redmine Notificações — Extensão de Navegador

Extensão para Chrome/Edge que notifica sobre suas demandas no Redmine em tempo real.

## Funcionalidades

- 🔔 **Notificações de prazo** — Alerta quando um REDMINE está perto de vencer ou atrasada
- 🔄 **Mudanças de status** — Notifica quando o status de uma demanda muda
- 🔴 **Prioridade alterada** — Alerta sobre mudanças de prioridade
- 💬 **Novos comentários** — Notifica sobre novos comentários em seu REDMINE
- 📋 **Novas atribuições** — Avisa quando uma nova demanda é atribuída a você
- 📊 **Painel popup** — Visão geral rápida de todas as suas demandas abertas

## Instalação

### 1. Instalar no Chrome/Edge

1. Abra `chrome://extensions/` (ou `edge://extensions/`)
2. Ative o **Modo do desenvolvedor** (toggle no canto superior direito)
3. Clique em **"Carregar sem compactação"**
4. Selecione a pasta `redmine-Notificações/`

### 2. Configurar

1. Clique no ícone da extensão → ⚙️ (engrenagem)
2. Informe a **URL do seu Redmine** (ex: `https://redmine.empresa.com`)
3. Informe sua **API Key** (encontrada em: Minha conta → Chave de acesso à API)
4. Clique em **Testar Conexão** para verificar
5. Ajuste o intervalo de verificação e tipos de notificação
6. Salve!

## Como funciona

- A extensão consulta a API REST do Redmine a cada X minutos (configurável)
- Compara o estado atual dos REDMINES com o estado anterior
- Envia notificações do navegador para qualquer mudança detectada
- O badge vermelho no ícone mostra quantos REDMINES urgentes existem
- Clique em uma notificação para abrir o REDMINE diretamente no Redmine

## Requisitos

- Redmine com API REST habilitada (Administração → Configurações → API)
- API Key do usuário gerada
- Chrome 88+ ou Edge 88+ (Manifest V3)

## Estrutura do Projeto

```
redmine-Notificações/
├── manifest.json           # Configuração da extensão (Manifest V3)
├── background/
│   └── service-worker.js   # Polling do Redmine + notificações
├── popup/
│   ├── popup.html          # Interface do popup
│   ├── popup.css           # Estilos do popup
│   └── popup.js            # Lógica do popup
├── options/
│   ├── options.html        # Página de configurações
│   ├── options.css         # Estilos das configurações
│   └── options.js          # Lógica das configurações
├── icons/
│   └── generate-icons.html # Gerador de ícones
└── README.md
```

## Segurança

- A API Key é armazenada no `chrome.storage.sync` (sincronizada com a conta Google, criptografada)
- Nenhum dado é enviado para terceiros — comunicação direta com seu Redmine
- Permissões mínimas necessárias (alarms, notifications, storage)
