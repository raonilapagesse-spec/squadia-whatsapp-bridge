# SquadIA WhatsApp Bridge

API de integração com WhatsApp usando Baileys para pareamento e gerenciamento de sessões.

## 🚀 Features

- ✅ Pareamento automático via código 6 dígitos
- ✅ Gerenciamento de múltiplas sessões simultâneas
- ✅ Webhooks para eventos (status, mensagens, chats)
- ✅ Suporte a mídia (imagens, vídeos, áudio, documentos)
- ✅ Graceful shutdown com proteção `stopped`
- ✅ Proteção contra regeneração silenciosa de sessões
- ✅ Identificação como macOS Desktop para melhor compatibilidade

## 📋 Variáveis de Ambiente

```env
# Obrigatórias
BRIDGE_TOKEN=seu_token_secreto
BRIDGE_WEBHOOK_SECRET=seu_webhook_secret

# Opcionais
PORT=8080
BRIDGE_DATA_DIR=/data/sessions
LOG_LEVEL=warn
```

## 🔧 Endpoints

### Autenticação
Todas as rotas (exceto `/health`) requerem header:
```
Authorization: Bearer ${BRIDGE_TOKEN}
```

### GET /health
Verifica saúde da API.

```bash
curl http://localhost:8080/health
```

### POST /sessions
Cria uma nova sessão WhatsApp.

```bash
curl -X POST http://localhost:8080/sessions \
  -H "Authorization: Bearer seu_token" \
  -H "Content-Type: application/json" \
  -d '{
    "externalId": "user123",
    "phone": "5511999999999",
    "webhookUrl": "https://seu-app.com/webhook"
  }'
```

**Response:**
```json
{
  "sessionRef": "u_user123",
  "pairingCode": "123456",
  "status": "pairing"
}
```

### GET /sessions/:ref
Obtém status de uma sessão.

```bash
curl http://localhost:8080/sessions/u_user123 \
  -H "Authorization: Bearer seu_token"
```

### DELETE /sessions/:ref
Encerra uma sessão.

```bash
curl -X DELETE http://localhost:8080/sessions/u_user123 \
  -H "Authorization: Bearer seu_token"
```

### POST /sessions/:ref/messages
Envia uma mensagem.

```bash
curl -X POST http://localhost:8080/sessions/u_user123/messages \
  -H "Authorization: Bearer seu_token" \
  -H "Content-Type: application/json" \
  -d '{
    "chatId": "5511999999999@s.whatsapp.net",
    "text": "Olá!"
  }'
```

### GET /sessions/:ref/media/:mediaRef
Baixa uma mídia recebida.

```bash
curl http://localhost:8080/sessions/u_user123/media/abc123 \
  -H "Authorization: Bearer seu_token"
```

## 🔔 Webhooks

A ponte envia eventos via POST para `webhookUrl` com header:
```
x-squadia-signature: sha256=<hmac>
```

### Evento: status
```json
{
  "type": "status",
  "externalId": "user123",
  "status": "connected",
  "phone": "5511999999999",
  "error": null
}
```

### Evento: message
```json
{
  "type": "message",
  "externalId": "user123",
  "message": {
    "chatId": "5511999999999@s.whatsapp.net",
    "chatName": "Contato",
    "isGroup": false,
    "waMessageId": "xyz123",
    "fromMe": false,
    "author": "Contato",
    "body": "Oi, tudo bem?",
    "type": "text",
    "mediaRef": null,
    "sentAt": "2024-08-28T18:00:00.000Z"
  }
}
```

## 🚀 Deploy no Railway

1. Conecte este repositório no Railway
2. Configure as variáveis de ambiente
3. Deploy automático em cada push para `main`

## 🖥️ Desenvolvimento Local

```bash
# Instalar dependências
npm install

# Executar
BRIDGE_TOKEN=test123 BRIDGE_WEBHOOK_SECRET=secret123 npm start
```

## 📝 Notas

- Sessão salva em `/data/sessions/{sessionRef}/`
- Graceful shutdown protegido
- Prote gegen regeneração de código expirado
- Compatibilidade macOS Desktop

## 📄 Licença

MIT
