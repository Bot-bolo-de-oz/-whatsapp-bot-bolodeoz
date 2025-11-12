// index.js - Bot WhatsApp Bolo de Oz - Versão Melhorada
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const http = require('http');

// 🛡️ Configurações de Segurança
const CARDAPIO_FILE = path.join(__dirname, 'cardapio.json');
const PEDIDOS_FILE = path.join(__dirname, 'pedidos.json');
const LOG_FILE = path.join(__dirname, 'bot.log');
const PIX_CHAVE = '54606633000177';
const IFOOD_LINK = 'https://www.ifood.com.br/delivery/osasco/bolo-de-oz';

// 🎯 Estado com TTL (Time To Live) - Evita Memory Leak
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
setInterval(limparEstadoExpirado, 30 * 60 * 1000); // A cada 30min

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
      { id: 1, nome: "Bolo de Cenoura com Chocolate", preco: 25.00 },
      { id: 2, nome: "Bolo de Chocolate Caseiro", preco: 28.00 },
      { id: 3, nome: "Bolo Formigueiro", preco: 26.00 },
      { id: 4, nome: "Bolo de Fubá com Goiabada", preco: 24.00 },
      { id: 5, nome: "Bolo de Milho Cremoso", preco: 25.00 }
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

// 🌐 Health Check para Railway/Render
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'online',
    bot: 'WhatsApp Bot Bolo de Oz',
    metrics: METRICS,
    stateSize: STATE.size,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  }));
});

server.listen(PORT, () => {
  console.log(`🟢 Bot rodando na porta ${PORT}`);
  logger('inicializacao', 'sistema', { porta: PORT, status: 'online' });
});

// ⚡ Eventos do WhatsApp
client.on('qr', qr => {
  qrcode.generate(qr, { small: true });
  logger('qr', 'sistema', { acao: 'qr_gerado' });
});

client.on('ready', () => {
  console.log('✅ Bot conectado e pronto.');
  logger('inicializacao', 'sistema', { status: 'ready' });
});

client.on('disconnected', (reason) => {
  console.log('❌ Desconectado:', reason);
  logger('conexao', 'sistema', { acao: 'disconnected', reason });
  
  setTimeout(() => {
    console.log('🔄 Tentando reconectar...');
    client.initialize().catch(e => console.error('Erro na reconexão:', e));
  }, 10000);
});

client.on('auth_failure', (msg) => {
  console.error('❌ Falha na autenticação:', msg);
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
    if (/^(oi|olá|ola|menu|inicio|iniciar|start)$/i.test(textoEntrada)) {
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
  // Aqui você pode implementar lógica para receber comprovante
  // Por enquanto, qualquer mensagem confirma o pagamento
  
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
client.initialize().catch(err => {
  console.error('❌ Erro na inicialização:', err);
  logger('erro', 'sistema', { acao: 'inicializacao_falha', error: err.message });
});

console.log('🚀 Iniciando Bot WhatsApp Bolo de Oz...');
logger('sistema', 'sistema', { acao: 'inicio_aplicacao', versao: '2.0-melhorada' });
