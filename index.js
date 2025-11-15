// index.js - Bot WhatsApp Bolo de Oz - Versão com Web QR Code
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const express = require('express');
const fs = require('fs');
const path = require('path');

// 🛡️ Configurações de Segurança
const CARDAPIO_FILE = path.join(__dirname, 'cardapio.json');
const PEDIDOS_FILE = path.join(__dirname, 'pedidos.json');
const LOG_FILE = path.join(__dirname, 'bot.log');
const PIX_CHAVE = '54606633000177';
const IFOOD_LINK = 'https://www.ifood.com.br/delivery/osasco/bolo-de-oz';

// 🎯 Estado com TTL (Time To Live)
const STATE = new Map();
const STATE_TTL = 2 * 60 * 60 * 1000; // 2 horas

// 📊 Métricas do Bot
const METRICS = {
  mensagensRecebidas: 0,
  pedidosFinalizados: 0,
  usuariosAtivos: 0,
  erros: 0,
  iniciadoEm: new Date().toISOString()
};

// 🖥️ Configuração do Express
const app = express();
const PORT = process.env.PORT || 10000;

// Variáveis globais para status
let qrCodeData = null;
let isConnected = false;
let clientStatus = 'Desconectado';

// 🧹 Limpeza automática de estado
function limparEstadoExpirado() {
  const agora = Date.now();
  let removidos = 0;
  
  for (const [chatId, estado] of STATE.entries()) {
    if (agora - estado.timestamp > STATE_TTL) {
      STATE.delete(chatId);
      removidos++;
    }
  }
  
  if (removidos > 0) {
    logger('limpeza', 'sistema', { removidos });
  }
}
setInterval(limparEstadoExpirado, 30 * 60 * 1000);

// 📝 Sistema de Logs Estruturado
function logger(acao, chatId, detalhes = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    acao,
    chatId: chatId && chatId.substring ? chatId.substring(0, 8) + '...' : 'sistema',
    ...detalhes
  };
  
  console.log(JSON.stringify(logEntry));
  fs.appendFileSync(LOG_FILE, JSON.stringify(logEntry) + '\n');
}

// 🛡️ Validação e Sanitização
function validarNumeroProduto(input) {
  const numero = parseInt(input);
  return !isNaN(numero) && cardapio.some(p => p.id === numero);
}

function sanitizarTexto(texto) {
  if (typeof texto !== 'string') return '';
  return texto.trim().replace(/[^\w\sáéíóúãõâêîôûàèìòùç@.,!?-]/gi, '').substring(0, 500);
}

// 🔧 Wrapper Seguro para Operações
async function executarComSeguranca(operacao, chat, fallbackMsg = 'Ops! Algo deu errado. Tente novamente.') {
  try {
    await operacao();
  } catch (error) {
    console.error('Erro na operação:', error);
    METRICS.erros++;
    await safeSendMessage(chat, fallbackMsg);
    logger('erro', chat.id, { error: error.message });
  }
}

// 🎛️ Configuração Robusta do Puppeteer
const client = new Client({
  authStrategy: new LocalAuth({ 
    clientId: 'bot-bolodeoz-prod',
    dataPath: './wwebjs_auth'
  }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=VizDisplayCompositor',
      '--disable-ipc-flooding-protection'
    ]
  },
  restartOnAuthFail: true,
  takeoverOnConflict: true,
  qrMaxRetries: 10
});

// ⚙️ Sistema de Arquivos
function ensureCardapio() {
  if (!fs.existsSync(CARDAPIO_FILE)) {
    const defaultMenu = [
      { id: 1, nome: "Bolo de Cenoura com Cobertura de Chocolate", preco: 42.90 },
      { id: 2, nome: "Bolo de Chocolate com Cobertura de Chocolate", preco: 42.90 },
      { id: 3, nome: "Bolo Formigueiro", preco: 31.90 },
      { id: 4, nome: "Bolo de Fubá com Goiabada", preco: 31.90 },
      { id: 5, nome: "Bolo de Milho Cremoso", preco: 31.90 }
    ];
    fs.writeFileSync(CARDAPIO_FILE, JSON.stringify(defaultMenu, null, 2), 'utf8');
    logger('inicializacao', 'sistema', { acao: 'cardapio_criado' });
  }
}

function carregarCardapio() {
  try {
    const cardapio = JSON.parse(fs.readFileSync(CARDAPIO_FILE, 'utf8'));
    return Array.isArray(cardapio) ? cardapio : [];
  } catch (error) {
    logger('erro', 'sistema', { acao: 'carregar_cardapio', error: error.message });
    return [];
  }
}

function salvarPedido(pedido) {
  try {
    const pedidos = fs.existsSync(PEDIDOS_FILE) ? 
      JSON.parse(fs.readFileSync(PEDIDOS_FILE, 'utf8')) : [];
    
    pedidos.push({
      id: 'PD' + Date.now(),
      timestamp: new Date().toISOString(),
      ...pedido
    });
    
    fs.writeFileSync(PEDIDOS_FILE, JSON.stringify(pedidos, null, 2));
    logger('pedido', pedido.chatId, { 
      acao: 'pedido_salvo', 
      pedidoId: pedidos[pedidos.length - 1].id,
      total: pedido.total 
    });
    
    return true;
  } catch (error) {
    logger('erro', 'sistema', { acao: 'salvar_pedido', error: error.message });
    return false;
  }
}

let cardapio = carregarCardapio();
ensureCardapio();

function carregarCardapio() {
  try {
    if (!fs.existsSync(CARDAPIO_FILE)) {
      ensureCardapio();
    }
    
    const data = fs.readFileSync(CARDAPIO_FILE, 'utf8');
    
    // 🔧 CORREÇÃO FORTE - Se estiver vazio, recria
    if (!data || data.trim() === '' || data === '[]') {
      console.log('🔄 Cardápio vazio ou inválido, recriando...');
      ensureCardapio();
      return JSON.parse(fs.readFileSync(CARDAPIO_FILE, 'utf8'));
    }
    
    const cardapio = JSON.parse(data);
    return Array.isArray(cardapio) ? cardapio : [];
  } catch (error) {
    console.log('🔄 Erro ao carregar cardápio, recriando...', error.message);
    ensureCardapio();
    return JSON.parse(fs.readFileSync(CARDAPIO_FILE, 'utf8'));
  }
}

// 🏪 Sistema de Estados
const FLUXO = {
  MENU: 'menu',
  CARDAPIO: 'cardapio',
  CARRINHO: 'carrinho',
  FINALIZAR: 'finalizar',
  PAGAMENTO: 'pagamento'
};

function iniciarEstado(chatId) {
  const estado = {
    etapa: FLUXO.MENU,
    carrinho: [],
    total: 0,
    timestamp: Date.now(),
    usuario: {
      nome: '',
      telefone: chatId
    },
    closed: false
  };
  
  STATE.set(chatId, estado);
  METRICS.usuariosAtivos = STATE.size;
  
  return estado;
}

function obterEstado(chatId) {
  let estado = STATE.get(chatId);
  if (!estado) {
    estado = iniciarEstado(chatId);
  }
  estado.timestamp = Date.now(); // Atualiza TTL
  return estado;
}

// 💬 Sistema de Mensagens
function menuInicialMsg(nome = '') {
  const saud = nome ? `Olá ${nome}!` : 'Olá!';
  return `${saud} Bem-vindo(a) à *Bolo de Oz*! 🍰\n\n` +
         `Escolha uma opção:\n` +
         `1️⃣ Ver Cardápio\n` +
         `2️⃣ Localização\n` +
         `3️⃣ Chave PIX\n` +
         `4️⃣ Fazer pedido\n` +
         `5️⃣ Redes sociais & iFood\n` +
         `6️⃣ Chamar atendente\n` +
         `0️⃣ Voltar ao menu inicial\n` +
         `9️⃣ Encerrar conversa`;
}

function formatarCardapioTexto() {
  cardapio = carregarCardapio();
  let texto = '*📜 CARDÁPIO BOLO DE OZ*\n\n';
  cardapio.forEach(item => {
    texto += `${item.id} - ${item.nome}  —  R$ ${item.preco.toFixed(2)}\n`;
  });
  texto += `\nDigite o número do produto para adicionar ao carrinho.\n` +
           `0️⃣ Voltar\n9️⃣ Encerrar`;
  return texto;
}

function resumoCarrinhoText(carrinho) {
  if (!carrinho.length) return '🛒 Seu carrinho está vazio.';
  
  const total = carrinho.reduce((s, it) => s + it.preco, 0);
  let texto = '*🧾 RESUMO DO PEDIDO:*\n\n';
  
  carrinho.forEach((it, i) => {
    texto += `${i + 1}. ${it.nome} — R$ ${it.preco.toFixed(2)}\n`;
  });
  
  return texto + `\n*TOTAL: R$ ${total.toFixed(2)}*`;
}

function menuCarrinhoText(carrinho) {
  let texto = resumoCarrinhoText(carrinho);
  texto += '\n\n1️⃣ Adicionar mais itens\n' +
           '2️⃣ Remover último item\n' +
           '3️⃣ Limpar carrinho\n' +
           '4️⃣ Finalizar pedido\n' +
           '0️⃣ Voltar ao menu';
  return texto;
}

function gerarComanda(carrinho, chatId) {
  const total = carrinho.reduce((s, it) => s + it.preco, 0);
  let texto = `🧾 *COMANDA BOLO DE OZ*\n\n` +
              `Cliente: ${chatId}\n` +
              `Forma: PIX (${PIX_CHAVE})\n\n` +
              `*Itens:*\n`;
  
  carrinho.forEach((it, i) => {
    texto += `${i + 1}. ${it.nome} — R$ ${it.preco.toFixed(2)}\n`;
  });
  
  texto += `\n*Total: R$ ${total.toFixed(2)}*\n\n` +
           `Envie o comprovante do pagamento PIX para concluir.\n` +
           `0️⃣ Voltar\n9️⃣ Encerrar`;
  
  return texto;
}

// 🛡️ Proteção Contra ProtocolError
async function safeSendMessage(chat, text) {
  try {
    await chat.sendMessage(text);
    return true;
  } catch (err) {
    if (err.message.includes('Protocol error') || err.message.includes('Target closed')) {
      logger('erro', chat.id, { acao: 'protocol_error', error: err.message });
      console.log('⚠️ Puppeteer instável...');
      
      try {
        await client.destroy();
        setTimeout(() => {
          client.initialize().catch(e => console.error('Erro ao reiniciar:', e));
        }, 5000);
      } catch (restartError) {
        console.error('Erro ao reiniciar cliente:', restartError);
      }
    } else {
      logger('erro', chat.id, { acao: 'envio_mensagem', error: err.message });
      console.error('Erro ao enviar mensagem:', err.message);
    }
    return false;
  }
}

// 🌐 Rotas Web para QR Code e Status
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>WhatsApp Bot Bolo de Oz</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }
            
            body {
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                padding: 20px;
                color: #333;
            }
            
            .container {
                max-width: 800px;
                margin: 0 auto;
                background: white;
                border-radius: 20px;
                padding: 40px;
                box-shadow: 0 20px 40px rgba(0,0,0,0.1);
                text-align: center;
            }
            
            h1 {
                color: #4a5568;
                margin-bottom: 10px;
                font-size: 2.5em;
            }
            
            .subtitle {
                color: #718096;
                margin-bottom: 30px;
                font-size: 1.2em;
            }
            
            .status-card {
                background: #f7fafc;
                border-radius: 15px;
                padding: 25px;
                margin: 25px 0;
                border-left: 5px solid #4299e1;
            }
            
            .connected { border-left-color: #48bb78; }
            .waiting { border-left-color: #ed8936; }
            .disconnected { border-left-color: #f56565; }
            
            .qr-container {
                margin: 30px 0;
                padding: 20px;
                background: white;
                border-radius: 15px;
                border: 3px dashed #e2e8f0;
            }
            
            .qr-code {
                max-width: 300px;
                margin: 0 auto;
                border-radius: 10px;
            }
            
            .steps {
                text-align: left;
                max-width: 400px;
                margin: 0 auto;
                background: #f8f9fa;
                padding: 20px;
                border-radius: 10px;
                margin-top: 20px;
            }
            
            .steps ol {
                margin-left: 20px;
            }
            
            .steps li {
                margin-bottom: 10px;
                line-height: 1.5;
            }
            
            .metrics {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 15px;
                margin-top: 30px;
            }
            
            .metric-card {
                background: white;
                padding: 15px;
                border-radius: 10px;
                border: 1px solid #e2e8f0;
                text-align: center;
            }
            
            .metric-value {
                font-size: 2em;
                font-weight: bold;
                color: #4299e1;
                margin: 10px 0;
            }
            
            .btn {
                background: #4299e1;
                color: white;
                border: none;
                padding: 12px 24px;
                border-radius: 8px;
                cursor: pointer;
                font-size: 1em;
                margin: 10px;
                text-decoration: none;
                display: inline-block;
            }
            
            .btn:hover {
                background: #3182ce;
            }
            
            .last-update {
                margin-top: 20px;
                color: #718096;
                font-size: 0.9em;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🤖 WhatsApp Bot</h1>
            <div class="subtitle">Bolo de Oz - Sistema de Pedidos</div>
            
            <div class="status-card ${isConnected ? 'connected' : qrCodeData ? 'waiting' : 'disconnected'}">
                <h2>📱 Status da Conexão</h2>
                <div class="status-text">
                    ${isConnected ? 
                        '<p style="color: #48bb78; font-size: 1.3em; font-weight: bold;">✅ WhatsApp Conectado!</p><p>Bot está funcionando normalmente e pronto para receber pedidos.</p>' : 
                        qrCodeData ? 
                        '<p style="color: #ed8936; font-size: 1.3em; font-weight: bold;">⏳ Aguardando Escaneamento</p><p>Escaneie o QR Code abaixo para conectar o WhatsApp.</p>' :
                        '<p style="color: #f56565; font-size: 1.3em; font-weight: bold;">❌ Desconectado</p><p>Aguardando geração do QR Code...</p>'
                    }
                </div>
                <p><strong>Status do Cliente:</strong> ${clientStatus}</p>
            </div>
            
            ${qrCodeData && !isConnected ? `
                <div class="qr-container">
                    <h3>🔐 QR Code para Conectar</h3>
                    <img src="${qrCodeData}" alt="QR Code WhatsApp" class="qr-code">
                    <div class="steps">
                        <h4>📋 Como conectar:</h4>
                        <ol>
                            <li>Abra o WhatsApp no seu celular</li>
                            <li>Toque em ⋮ (Menu) → Dispositivos conectados</li>
                            <li>Toque em "Conectar um dispositivo"</li>
                            <li>Aponte a câmera para o QR Code acima</li>
                            <li>Aguarde a confirmação de conexão</li>
                        </ol>
                    </div>
                </div>
            ` : ''}
            
            <div class="metrics">
                <div class="metric-card">
                    <div>💬 Mensagens</div>
                    <div class="metric-value">${METRICS.mensagensRecebidas}</div>
                    <div>Recebidas</div>
                </div>
                <div class="metric-card">
                    <div>🛒 Pedidos</div>
                    <div class="metric-value">${METRICS.pedidosFinalizados}</div>
                    <div>Finalizados</div>
                </div>
                <div class="metric-card">
                    <div>👥 Usuários</div>
                    <div class="metric-value">${METRICS.usuariosAtivos}</div>
                    <div>Ativos</div>
                </div>
                <div class="metric-card">
                    <div>⏱️ Uptime</div>
                    <div class="metric-value">${Math.floor(process.uptime() / 60)}min</div>
                    <div>Online</div>
                </div>
            </div>
            
            <div style="margin-top: 30px;">
                <button class="btn" onclick="location.reload()">🔄 Atualizar Página</button>
                <a href="/status" class="btn">📊 Status Detalhado</a>
            </div>
            
            <div class="last-update">
                Última atualização: ${new Date().toLocaleString('pt-BR')}
            </div>
        </div>
        
        <script>
            // Atualizar a página a cada 30 segundos se não estiver conectado
            if (!${isConnected}) {
                setTimeout(() => {
                    location.reload();
                }, 30000);
            }
        </script>
    </body>
    </html>
  `);
});

app.get('/status', (req, res) => {
  res.json({
    status: isConnected ? 'connected' : 'disconnected',
    whatsappConnected: isConnected,
    qrCodeAvailable: !!qrCodeData,
    metrics: METRICS,
    stateSize: STATE.size,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    clientStatus: clientStatus
  });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🟢 Bot rodando na porta ${PORT}`);
  console.log(`🌐 Acesse: https://whatsapp-bot-bolodeoz.onrender.com`);
  logger('inicializacao', 'sistema', { porta: PORT, status: 'online' });
});

// ⚡ Eventos do WhatsApp
client.on('qr', async (qr) => {
  console.log('📱 QR Code recebido, gerando imagem...');
  clientStatus = 'QR Code Gerado';
  
  try {
    // Gerar QR Code como imagem base64
    const qrImage = await qrcode.toDataURL(qr);
    qrCodeData = qrImage;
    isConnected = false;
    
    console.log('✅ QR Code disponível na web: https://whatsapp-bot-bolodeoz.onrender.com');
    logger('qr', 'sistema', { acao: 'qr_gerado', web: true });
  } catch (error) {
    console.error('Erro ao gerar QR Code:', error);
    // Fallback: mostrar QR no terminal
    const qrcodeTerminal = require('qrcode-terminal');
    qrcodeTerminal.generate(qr, { small: true });
    logger('erro', 'sistema', { acao: 'qr_fallback', error: error.message });
  }
});

client.on('ready', () => {
  console.log('✅ Bot conectado e pronto!');
  isConnected = true;
  qrCodeData = null;
  clientStatus = 'Conectado e Pronto';
  logger('conexao', 'sistema', { status: 'ready' });
});

client.on('disconnected', (reason) => {
  console.log('❌ Desconectado:', reason);
  isConnected = false;
  clientStatus = `Desconectado: ${reason}`;
  logger('conexao', 'sistema', { acao: 'disconnected', reason });
  
  setTimeout(() => {
    console.log('🔄 Tentando reconectar...');
    clientStatus = 'Tentando reconectar...';
    client.initialize().catch(e => {
      console.error('Erro na reconexão:', e);
      clientStatus = `Erro na reconexão: ${e.message}`;
    });
  }, 10000);
});

client.on('auth_failure', (msg) => {
  console.error('❌ Falha na autenticação:', msg);
  clientStatus = `Falha na autenticação: ${msg}`;
  logger('auth', 'sistema', { acao: 'auth_failure', msg });
});

// 🧠 Lógica Principal de Mensagens
client.on('message', async msg => {
  // Ignorar mensagens de grupos e status
  if (msg.from.includes('@g.us') || msg.from.includes('status@broadcast')) {
    return;
  }

  const chat = await msg.getChat();
  const chatId = msg.from;
  const textoEntrada = sanitizarTexto(msg.body);
  
  METRICS.mensagensRecebidas++;
  
  await executarComSeguranca(async () => {
    const estado = obterEstado(chatId);
    
    if (estado.closed && textoEntrada !== '0') {
      return; // Ignora mensagens se conversa foi encerrada
    }

    // Comando de encerramento
    if (textoEntrada === '9') {
      estado.closed = true;
      await safeSendMessage(chat, '🙏 Obrigado pelo contato! Até logo! 🎂');
      logger('conversa', chatId, { acao: 'encerrada' });
      return;
    }

    // Reiniciar conversa
    if (textoEntrada === '0') {
      iniciarEstado(chatId);
      await safeSendMessage(chat, menuInicialMsg());
      logger('conversa', chatId, { acao: 'reiniciada' });
      return;
    }

    // Saudação inicial
    if (/^(oi|olá|ola|menu|inicio|iniciar|boa tarde|bom di|bolo caseiro|hello|informação|informações|pedido|bolo|start)$/i.test(textoEntrada)) {
      await safeSendMessage(chat, menuInicialMsg());
      estado.etapa = FLUXO.MENU;
      logger('interacao', chatId, { acao: 'saudacao', etapa: estado.etapa });
      return;
    }

    // Lógica por etapa
    switch (estado.etapa) {
      case FLUXO.MENU:
        await handleMenu(chat, estado, textoEntrada, chatId);
        break;
        
      case FLUXO.CARDAPIO:
        await handleCardapio(chat, estado, textoEntrada, chatId);
        break;
        
      case FLUXO.CARRINHO:
        await handleCarrinho(chat, estado, textoEntrada, chatId);
        break;
        
      case FLUXO.PAGAMENTO:
        await handlePagamento(chat, estado, textoEntrada, chatId);
        break;
    }
  }, chat);
});

// 🎯 Handlers Específicos
async function handleMenu(chat, estado, texto, chatId) {
  switch (texto) {
    case '1':
    case '4': // Fazer pedido
      estado.etapa = FLUXO.CARDAPIO;
      await safeSendMessage(chat, formatarCardapioTexto());
      logger('navegacao', chatId, { de: 'menu', para: 'cardapio' });
      break;
      
    case '2':
      await safeSendMessage(chat, '📍 Rua Dona Palmira - Helena Maria - Osasco - SP');
      logger('info', chatId, { acao: 'localizacao' });
      break;
      
    case '3':
      await safeSendMessage(chat, `💳 Chave PIX (CNPJ): ${PIX_CHAVE}`);
      logger('info', chatId, { acao: 'pix' });
      break;
      
    case '5':
      await safeSendMessage(chat, 
        `🌐 Instagram: https://instagram.com/bolodeoz\n` +
        `🍴 iFood: ${IFOOD_LINK}`
      );
      logger('info', chatId, { acao: 'redes_sociais' });
      break;
      
    case '6':
      await safeSendMessage(chat, 
        '📞 Para falar com um atendente, envie uma mensagem diretamente para nosso WhatsApp comercial.'
      );
      logger('info', chatId, { acao: 'atendente' });
      break;
      
    default:
      await safeSendMessage(chat, menuInicialMsg());
      break;
  }
}

async function handleCardapio(chat, estado, texto, chatId) {
  if (texto === '0') {
    estado.etapa = FLUXO.MENU;
    await safeSendMessage(chat, menuInicialMsg());
    logger('navegacao', chatId, { de: 'cardapio', para: 'menu' });
    return;
  }

  const produto = cardapio.find(p => p.id === parseInt(texto));
  if (produto) {
    estado.carrinho.push(produto);
    estado.total = estado.carrinho.reduce((s, it) => s + it.preco, 0);
    
    await safeSendMessage(chat, 
      `✅ ${produto.nome} adicionado!\n\n${menuCarrinhoText(estado.carrinho)}`
    );
    
    estado.etapa = FLUXO.CARRINHO;
    logger('pedido', chatId, { 
      acao: 'item_adicionado', 
      produto: produto.nome, 
      carrinho: estado.carrinho.length 
    });
  } else {
    await safeSendMessage(chat, 
      '❌ Número inválido. Digite um número do cardápio ou 0 para voltar.'
    );
  }
}

async function handleCarrinho(chat, estado, texto, chatId) {
  switch (texto) {
    case '1': // Adicionar mais
      estado.etapa = FLUXO.CARDAPIO;
      await safeSendMessage(chat, formatarCardapioTexto());
      logger('navegacao', chatId, { de: 'carrinho', para: 'cardapio' });
      break;
      
    case '2': // Remover último
      if (estado.carrinho.length > 0) {
        const removido = estado.carrinho.pop();
        estado.total = estado.carrinho.reduce((s, it) => s + it.preco, 0);
        
        await safeSendMessage(chat, 
          `🗑️ ${removido.nome} removido!\n\n${menuCarrinhoText(estado.carrinho)}`
        );
        logger('pedido', chatId, { 
          acao: 'item_removido', 
          produto: removido.nome, 
          carrinho: estado.carrinho.length 
        });
      } else {
        await safeSendMessage(chat, '❌ Carrinho já está vazio.');
      }
      break;
      
    case '3': // Limpar carrinho
      estado.carrinho = [];
      estado.total = 0;
      await safeSendMessage(chat, '🗑️ Carrinho limpo!\n\n' + menuInicialMsg());
      estado.etapa = FLUXO.MENU;
      logger('pedido', chatId, { acao: 'carrinho_limpo' });
      break;
      
    case '4': // Finalizar
      if (estado.carrinho.length === 0) {
        await safeSendMessage(chat, '❌ Carrinho vazio. Adicione itens primeiro.');
        return;
      }
      
      estado.etapa = FLUXO.PAGAMENTO;
      await safeSendMessage(chat, gerarComanda(estado.carrinho, chatId));
      logger('pedido', chatId, { 
        acao: 'finalizacao', 
        itens: estado.carrinho.length, 
        total: estado.total 
      });
      break;
      
    default:
      await safeSendMessage(chat, menuCarrinhoText(estado.carrinho));
      break;
  }
}

async function handlePagamento(chat, estado, texto, chatId) {
  const pedidoSalvo = salvarPedido({
    chatId: chatId,
    itens: [...estado.carrinho],
    total: estado.total,
    status: 'confirmado'
  });
  
  if (pedidoSalvo) {
    METRICS.pedidosFinalizados++;
    
    await safeSendMessage(chat,
      '✅ Pagamento confirmado! Seu pedido está sendo preparado. 🎂\n\n' +
      'Agradecemos pela preferência! Volte sempre! 😊'
    );
    
    logger('pedido', chatId, { 
      acao: 'pagamento_confirmado', 
      itens: estado.carrinho.length, 
      total: estado.total 
    });
  } else {
    await safeSendMessage(chat,
      '❌ Erro ao processar pedido. Entre em contato conosco diretamente.'
    );
  }
  
  // Reinicia estado
  iniciarEstado(chatId);
}

// 🛡️ Tratamento de Erros Globais
process.on('unhandledRejection', (err) => {
  console.error('UnhandledRejection:', err);
  logger('erro', 'sistema', { tipo: 'unhandledRejection', error: err.message });
});

process.on('uncaughtException', (err) => {
  console.error('UncaughtException:', err);
  logger('erro', 'sistema', { tipo: 'uncaughtException', error: err.message });
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('🔄 Encerrando bot graciosamente...');
  logger('sistema', 'sistema', { acao: 'shutdown', motivo: 'SIGINT' });
  
  try {
    await client.destroy();
    console.log('✅ Bot encerrado com sucesso.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Erro ao encerrar:', error);
    process.exit(1);
  }
});

// Inicializar bot
console.log('🚀 Iniciando Bot WhatsApp Bolo de Oz...');
logger('sistema', 'sistema', { acao: 'inicio_aplicacao', versao: '2.0-web-qrcode' });

client.initialize().catch(err => {
  console.error('❌ Erro na inicialização:', err);
  clientStatus = `Erro na inicialização: ${err.message}`;
  logger('erro', 'sistema', { acao: 'inicializacao_falha', error: err.message });
});