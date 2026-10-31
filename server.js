
'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '2mb' }));

const CONFIG = {
    PORT: Number(process.env.PORT || 3000),
    AMAZON_TAG: 'davi0fe-20',
    WHATSAPP_GRUPO: '120363433203462092@g.us',

    ML_CLIENT_ID: '3281038521495080',
    ML_CLIENT_SECRET: process.env.MERCADOLIVRE_CLIENT_SECRET || '',
    ML_REDIRECT_URI:
        process.env.MERCADOLIVRE_REDIRECT_URI ||
        'https://wriggle-timid-enquirer.ngrok-free.dev/callback',

    CHROME: process.env.CHROME_PATH ||
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',

    INTERVALO_BUSCA: 60_000,
    INTERVALO_ENVIO: 15_000,
    LIMITE_AMAZON: 120
};

const ARQUIVOS = {
    BANCO: path.join(__dirname, 'ofertas.db'),
    LINKS_ML: path.join(__dirname, 'links-mercadolivre.json'),
    TOKEN_ML: path.join(__dirname, 'mercadolivre-token.json'),
    PRODUTOS_ML: path.join(__dirname, 'mercadolivre-produtos.json')
};

let whatsappPronto = false;
let bancoPronto = false;
let mineracaoAtiva = false;
let envioAtivo = false;
let rodada = 0;
let estadoOAuth = null;
let renovacaoEmAndamento = null;

const db = new sqlite3.Database(ARQUIVOS.BANCO);

function log(tipo, mensagem) {
    console.log(
        `[${new Date().toLocaleString('pt-BR')}] [${tipo}] ${mensagem}`
    );
}

function esperar(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function executarSQL(sql, parametros = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, parametros, function (erro) {
            if (erro) return reject(erro);
            resolve(this);
        });
    });
}

function consultarSQL(sql, parametros = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, parametros, (erro, resultado) => {
            if (erro) return reject(erro);
            resolve(resultado);
        });
    });
}

function consultarTodos(sql, parametros = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, parametros, (erro, resultados) => {
            if (erro) return reject(erro);
            resolve(resultados || []);
        });
    });
}

// ======================================================
// BANCO DE DADOS
// ======================================================

async function inicializarBanco() {
    await executarSQL(`
        CREATE TABLE IF NOT EXISTS ofertas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            texto TEXT,
            link_afiliado TEXT UNIQUE,
            loja TEXT,
            postado_no_canal INTEGER DEFAULT 0,
            data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    const colunas = await consultarTodos('PRAGMA table_info(ofertas)');
    const existentes = colunas.map(c => c.name);

    const migracoes = {
        texto: 'TEXT',
        link_afiliado: 'TEXT',
        loja: 'TEXT',
        postado_no_canal: 'INTEGER DEFAULT 0',
        data_criacao: 'DATETIME'
    };

    for (const [nome, tipo] of Object.entries(migracoes)) {
        if (!existentes.includes(nome)) {
            await executarSQL(
                `ALTER TABLE ofertas ADD COLUMN ${nome} ${tipo}`
            );
        }
    }

    await executarSQL(`
        CREATE INDEX IF NOT EXISTS idx_ofertas_status
        ON ofertas(postado_no_canal)
    `);

    bancoPronto = true;
    log('BANCO', 'Banco de dados pronto.');
}

// ======================================================
// OAUTH MERCADO LIVRE
// ======================================================

function carregarTokenML() {
    try {
        if (!fs.existsSync(ARQUIVOS.TOKEN_ML)) return null;

        return JSON.parse(
            fs.readFileSync(ARQUIVOS.TOKEN_ML, 'utf8')
        );
    } catch (erro) {
        log('OAUTH', `Erro ao ler tokens: ${erro.message}`);
        return null;
    }
}

function salvarTokenML(dados) {
    const atual = carregarTokenML() || {};

    const novo = {
        ...atual,
        ...dados,
        atualizado_em: Date.now()
    };

    fs.writeFileSync(
        ARQUIVOS.TOKEN_ML,
        JSON.stringify(novo, null, 2),
        'utf8'
    );

    return novo;
}

function validarConfiguracaoOAuth() {
    if (!CONFIG.ML_CLIENT_SECRET) {
        throw new Error(
            'Client Secret não configurado. Configure MERCADOLIVRE_CLIENT_SECRET.'
        );
    }

    if (!CONFIG.ML_CLIENT_ID || !CONFIG.ML_REDIRECT_URI) {
        throw new Error('Client ID ou URL de retorno não configurados.');
    }
}

function criarUrlAutorizacao() {
    validarConfiguracaoOAuth();

    estadoOAuth = crypto.randomBytes(32).toString('hex');

    const url = new URL(
        'https://auth.mercadolivre.com.br/authorization'
    );

    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', CONFIG.ML_CLIENT_ID);
    url.searchParams.set('redirect_uri', CONFIG.ML_REDIRECT_URI);
    url.searchParams.set('state', estadoOAuth);

    return url.toString();
}

async function requisitarTokenML(parametros) {
    validarConfiguracaoOAuth();

    const corpo = new URLSearchParams({
        client_id: CONFIG.ML_CLIENT_ID,
        client_secret: CONFIG.ML_CLIENT_SECRET,
        ...parametros
    });

    const resposta = await fetch(
        'https://api.mercadolibre.com/oauth/token',
        {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: corpo
        }
    );

    const dados = await resposta.json().catch(() => ({}));

    if (!resposta.ok) {
        throw new Error(
            `Erro OAuth ${resposta.status}: ${
                dados.message ||
                dados.error_description ||
                dados.error ||
                'Falha na autorização'
            }`
        );
    }

    if (!dados.access_token || !dados.refresh_token) {
        throw new Error('Mercado Livre não retornou os tokens esperados.');
    }

    const expiracao = Date.now() + (Number(dados.expires_in) * 1000);

    salvarTokenML({
        access_token: dados.access_token,
        refresh_token: dados.refresh_token,
        expires_at: expiracao,
        user_id: dados.user_id || null,
        scope: dados.scope || ''
    });

    log('OAUTH', 'Tokens do Mercado Livre salvos.');
    return dados;
}

async function trocarCodigoPorToken(codigo) {
    return requisitarTokenML({
        grant_type: 'authorization_code',
        code: codigo,
        redirect_uri: CONFIG.ML_REDIRECT_URI
    });
}

async function renovarTokenML() {
    if (renovacaoEmAndamento) return renovacaoEmAndamento;

    renovacaoEmAndamento = (async () => {
        const token = carregarTokenML();

        if (!token || !token.refresh_token) {
            throw new Error(
                'Não existe Refresh Token. Autorize o aplicativo primeiro.'
            );
        }

        log('OAUTH', 'Renovando token do Mercado Livre.');

        return requisitarTokenML({
            grant_type: 'refresh_token',
            refresh_token: token.refresh_token
        });
    })();

    try {
        return await renovacaoEmAndamento;
    } finally {
        renovacaoEmAndamento = null;
    }
}

async function obterAccessTokenML() {
    const token = carregarTokenML();

    if (!token || !token.access_token) {
        throw new Error(
            'Mercado Livre não autorizado. Acesse /ml/autorizar.'
        );
    }

    if (!token.expires_at || Date.now() >= token.expires_at - 120000) {
        const novo = await renovarTokenML();
        return novo.access_token;
    }

    return token.access_token;
}

app.get('/ml/autorizar', (req, res) => {
    try {
        const url = criarUrlAutorizacao();
        res.redirect(url);
    } catch (erro) {
        log('OAUTH', erro.message);
        res.status(500).send(
            'Não foi possível iniciar a autorização. Confira as configurações.'
        );
    }
});

app.get('/callback', async (req, res) => {
    try {
        const { code, state, error, error_description } = req.query;

        if (error) {
            return res.status(400).send(
                `Autorização recusada: ${String(error_description || error)}`
            );
        }

        if (!code) {
            return res.status(400).send(
                'Código de autorização não recebido.'
            );
        }

        if (!estadoOAuth || !state || state !== estadoOAuth) {
            return res.status(400).send(
                'Estado de segurança inválido. Inicie a autorização novamente.'
            );
        }

        estadoOAuth = null;

        await trocarCodigoPorToken(String(code));

        res.send(`
            <html lang="pt-BR">
            <meta charset="UTF-8">
            <title>Mercado Livre autorizado</title>
            <body style="font-family:Arial;padding:40px">
                <h1>Mercado Livre autorizado!</h1>
                <p>Os tokens foram salvos. Você já pode voltar ao bot.</p>
            </body>
            </html>
        `);
    } catch (erro) {
        log('ERRO OAUTH', erro.message);
        res.status(500).send(
            `Falha na autorização: ${erro.message}`
        );
    }
});

// ======================================================
// LINKS E PRODUTOS DO MERCADO LIVRE
// ======================================================

function carregarLinksML() {
    try {
        if (!fs.existsSync(ARQUIVOS.LINKS_ML)) {
            fs.writeFileSync(ARQUIVOS.LINKS_ML, '{}', 'utf8');
        }

        const dados = JSON.parse(
            fs.readFileSync(ARQUIVOS.LINKS_ML, 'utf8')
        );

        return dados &&
            typeof dados === 'object' &&
            !Array.isArray(dados)
            ? dados
            : {};
    } catch (erro) {
        log('ERRO', `Falha ao ler links ML: ${erro.message}`);
        return {};
    }
}

function carregarProdutosML() {
    try {
        if (!fs.existsSync(ARQUIVOS.PRODUTOS_ML)) {
            fs.writeFileSync(
                ARQUIVOS.PRODUTOS_ML,
                '[]',
                'utf8'
            );
        }

        const dados = JSON.parse(
            fs.readFileSync(ARQUIVOS.PRODUTOS_ML, 'utf8')
        );

        return Array.isArray(dados) ? dados : [];
    } catch (erro) {
        log('ERRO ML', `Falha ao ler produtos: ${erro.message}`);
        return [];
    }
}

function salvarProdutosML(produtos) {
    fs.writeFileSync(
        ARQUIVOS.PRODUTOS_ML,
        JSON.stringify(produtos, null, 2),
        'utf8'
    );
}

function normalizarMLB(valor) {
    const match = String(valor || '').match(/MLB-?(\d{8,})/i);
    return match ? `MLB${match[1]}` : null;
}

function encontrarLinkAfiliadoML(id, links) {
    const procurado = normalizarMLB(id);
    if (!procurado) return null;

    for (const [chave, valor] of Object.entries(links)) {
        if (normalizarMLB(chave) === procurado) {
            return valor;
        }
    }

    return null;
}

function linkMLValido(link) {
    try {
        const url = new URL(link);

        return url.protocol === 'https:' &&
            [
                'meli.la',
                'www.meli.la',
                'mercadolivre.com.br',
                'www.mercadolivre.com.br',
                'produto.mercadolivre.com.br'
            ].includes(url.hostname) &&
            !link.includes('${');
    } catch {
        return false;
    }
}

function linkAmazonValido(link) {
    try {
        const url = new URL(link);

        return url.protocol === 'https:' &&
            url.hostname === 'www.amazon.com.br' &&
            url.searchParams.get('tag') === CONFIG.AMAZON_TAG;
    } catch {
        return false;
    }
}

function validarOferta(loja, link) {
    if (loja === 'Amazon') return linkAmazonValido(link);
    if (loja === 'Mercado Livre') return linkMLValido(link);
    return false;
}

// ======================================================
// CADASTRO DE OFERTAS
// ======================================================

async function cadastrarOferta(loja, titulo, link, preco = '') {
    if (!titulo || !link || !validarOferta(loja, link)) {
        return false;
    }

    const cabecalho = loja === 'Amazon'
        ? '🟠 *OFERTA DA AMAZON!*'
        : '🟡 *OFERTA DO MERCADO LIVRE!*';

    const texto = [
        cabecalho,
        '',
        `📦 *${titulo}*`,
        '',
        preco || '💰 Confira o preço atualizado:',
        '',
        `🔗 ${link}`,
        '',
        '⚠️ Preço e disponibilidade podem mudar.'
    ].join('\n');

    const resultado = await executarSQL(
        `INSERT OR IGNORE INTO ofertas
         (texto, link_afiliado, loja, postado_no_canal)
         VALUES (?, ?, ?, 0)`,
        [texto, link, loja]
    );

    if (resultado.changes > 0) {
        log(loja.toUpperCase(), `Oferta cadastrada: ${titulo}`);
        return true;
    }

    return false;
}

// ======================================================
// AMAZON
// ======================================================

function gerarLinkAmazon(asin) {
    if (!/^[A-Z0-9]{10}$/i.test(String(asin || ''))) {
        return null;
    }

    const url = new URL(
        `https://www.amazon.com.br/dp/${asin}`
    );

    url.searchParams.set('tag', CONFIG.AMAZON_TAG);

    return url.toString();
}

function opcoesPuppeteer() {
    const opcoes = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage'
        ]
    };

    if (fs.existsSync(CONFIG.CHROME)) {
        opcoes.executablePath = CONFIG.CHROME;
    }

    return opcoes;
}

async function novaPagina(navegador) {
    const pagina = await navegador.newPage();

    await pagina.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36'
    );

    await pagina.setViewport({
        width: 1366,
        height: 900
    });

    pagina.setDefaultNavigationTimeout(60000);

    return pagina;
}

async function buscarAmazon() {
    log('AMAZON', 'Iniciando pesquisa.');

    let navegador;

    const termos = [
        'mais vendidos',
        'ofertas do dia',
        'fone bluetooth',
        'smartwatch',
        'acessorios celular',
        'casa e cozinha',
        'informatica',
        'beleza',
        'brinquedos',
        'ferramentas'
    ];

    const produtos = new Map();

    try {
        navegador = await puppeteer.launch(opcoesPuppeteer());

        const pagina = await novaPagina(navegador);

        for (const termo of termos) {
            if (produtos.size >= CONFIG.LIMITE_AMAZON) break;

            for (let numero = 1; numero <= 3; numero++) {
                if (produtos.size >= CONFIG.LIMITE_AMAZON) break;

                try {
                    const url =
                        `https://www.amazon.com.br/s?k=${encodeURIComponent(termo)}&page=${numero}`;

                    await pagina.goto(url, {
                        waitUntil: 'domcontentloaded'
                    });

                    await esperar(2500);

                    const encontrados = await pagina.evaluate(() => {
                        const resultado = new Map();

                        const cards = document.querySelectorAll(
                            '[data-component-type="s-search-result"]'
                        );

                        for (const card of cards) {
                            const link = card.querySelector(
                                'a[href*="/dp/"], a[href*="/gp/product/"]'
                            );

                            if (!link) continue;

                            const match = link.href.match(
                                /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i
                            );

                            if (!match) continue;

                            const asin = match[1].toUpperCase();

                            const titulo =
                                card.querySelector('h2')?.innerText?.trim() ||
                                card.querySelector('img')?.alt?.trim() ||
                                '';

                            if (titulo.length >= 5) {
                                resultado.set(asin, {
                                    asin,
                                    titulo
                                });
                            }
                        }

                        return Array.from(resultado.values());
                    });

                    for (const produto of encontrados) {
                        produtos.set(produto.asin, produto);

                        if (produtos.size >= CONFIG.LIMITE_AMAZON) {
                            break;
                        }
                    }

                    log('AMAZON', `Encontrados: ${produtos.size}`);
                    await esperar(1000);

                } catch (erro) {
                    log('AMAZON', `Erro: ${erro.message}`);
                }
            }
        }

        let novos = 0;

        for (const produto of produtos.values()) {
            if (await cadastrarOferta(
                'Amazon',
                produto.titulo,
                gerarLinkAmazon(produto.asin)
            )) {
                novos++;
            }
        }

        log('AMAZON', `${novos} novas ofertas cadastradas.`);

    } catch (erro) {
        log('ERRO AMAZON', erro.message);
    } finally {
        if (navegador) {
            await navegador.close().catch(() => {});
        }
    }
}

// ======================================================
// MERCADO LIVRE - IMPORTAÇÃO DE PRODUTOS
// ======================================================

async function buscarMercadoLivre() {
    log(
        'MERCADO LIVRE',
        'Verificando produtos importados. Pesquisa automática pela API desativada.'
    );

    const produtos = carregarProdutosML();
    const linksAfiliados = carregarLinksML();

    if (produtos.length === 0) {
        log(
            'MERCADO LIVRE',
            'Nenhum produto importado. Use a área Mercado Livre no painel.'
        );
        return;
    }

    let cadastrados = 0;
    let semAfiliado = 0;

    for (const produto of produtos) {
        const id = normalizarMLB(produto.id || produto.mlb);

        if (!id || !produto.titulo) {
            continue;
        }

        const linkAfiliado = encontrarLinkAfiliadoML(
            id,
            linksAfiliados
        );

        if (!linkAfiliado || !linkMLValido(linkAfiliado)) {
            semAfiliado++;
            continue;
        }

        const preco = Number(produto.preco);

        const precoTexto = Number.isFinite(preco) && preco > 0
            ? `💰 Preço informado: R$ ${preco.toFixed(2).replace('.', ',')}`
            : '';

        if (await cadastrarOferta(
            'Mercado Livre',
            String(produto.titulo).trim(),
            linkAfiliado,
            precoTexto
        )) {
            cadastrados++;
        }
    }

    log(
        'MERCADO LIVRE',
        `${cadastrados} novas ofertas cadastradas.`
    );

    log(
        'MERCADO LIVRE',
        `${semAfiliado} produtos sem link de afiliado correspondente.`
    );
}

// ======================================================
// MINERAÇÃO
// ======================================================

async function executarMineracao() {
    if (mineracaoAtiva || !bancoPronto) return;

    mineracaoAtiva = true;
    rodada++;

    try {
        log('SISTEMA', `Iniciando rodada ${rodada}.`);

        await buscarAmazon();
        await buscarMercadoLivre();

        log('SISTEMA', `Rodada ${rodada} concluída.`);
    } catch (erro) {
        log('ERRO', erro.message);
    } finally {
        mineracaoAtiva = false;
    }
}

// ======================================================
// WHATSAPP
// ======================================================

const bot = new Client({
    authStrategy: new LocalAuth({
        clientId: 'sessao_unica'
    }),
    puppeteer: opcoesPuppeteer()
});

bot.on('qr', qr => {
    console.log('\n📱 ESCANEIE O QR CODE:\n');
    qrcode.generate(qr, { small: true });
});

bot.on('authenticated', () => {
    log('WHATSAPP', 'Autenticado.');
});

bot.on('auth_failure', mensagem => {
    whatsappPronto = false;
    log('ERRO WHATSAPP', mensagem);
});

bot.on('disconnected', motivo => {
    whatsappPronto = false;
    log('WHATSAPP', `Desconectado: ${motivo}`);
});

bot.on('ready', () => {
    whatsappPronto = true;
    log('WHATSAPP', 'Conectado e pronto para enviar ofertas.');
});

// ======================================================
// ENVIO AUTOMÁTICO
// ======================================================

async function enviarOferta() {
    if (!whatsappPronto || !bancoPronto || envioAtivo) {
        return;
    }

    envioAtivo = true;

    try {
        const pendentes = await consultarTodos(`
            SELECT *
            FROM ofertas
            WHERE postado_no_canal = 0
            ORDER BY id ASC
            LIMIT 100
        `);

        let oferta = null;

        for (const item of pendentes) {
            if (validarOferta(item.loja, item.link_afiliado)) {
                oferta = item;
                break;
            }

            await executarSQL(
                'UPDATE ofertas SET postado_no_canal = 2 WHERE id = ?',
                [item.id]
            );

            log(
                'AVISO',
                `Oferta ${item.id} descartada por link inválido.`
            );
        }

        if (!oferta) return;

        await bot.sendMessage(
            CONFIG.WHATSAPP_GRUPO,
            oferta.texto
        );

        await executarSQL(
            'UPDATE ofertas SET postado_no_canal = 1 WHERE id = ?',
            [oferta.id]
        );

        log(
            'WHATSAPP',
            `Oferta ${oferta.id} enviada ao grupo.`
        );

    } catch (erro) {
        log('ERRO ENVIO', erro.message);
    } finally {
        envioAtivo = false;
    }
}

// ======================================================
// PAINEL
// ======================================================

app.get('/', (req, res) => {
    res.type('html').send(`
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Painel do Bot de Ofertas</title>
<style>
* { box-sizing: border-box; }
body {
    margin: 0;
    padding: 25px;
    background: #101827;
    color: #f5f7fa;
    font-family: Arial, sans-serif;
}
.painel { max-width: 950px; margin: auto; }
h1 { color: #60a5fa; }
h2 { color: #93c5fd; }
.grade {
    display: grid;
    grid-template-columns: repeat(auto-fit,minmax(160px,1fr));
    gap: 15px;
}
.card {
    background: #1e293b;
    padding: 20px;
    border-radius: 12px;
    margin-top: 18px;
}
.numero {
    font-size: 30px;
    font-weight: bold;
    margin-top: 12px;
}
button {
    border: 0;
    border-radius: 8px;
    padding: 12px 18px;
    background: #2563eb;
    color: white;
    cursor: pointer;
    margin-top: 10px;
}
button:hover { background: #1d4ed8; }
textarea {
    width: 100%;
    min-height: 190px;
    padding: 12px;
    border-radius: 8px;
    border: 1px solid #475569;
    background: #0f172a;
    color: white;
    font-family: Consolas, monospace;
}
a { color: #93c5fd; }
.pequeno { color: #cbd5e1; font-size: 14px; line-height: 1.6; }
#resultadoImportacao { white-space: pre-wrap; }
</style>
</head>
<body>
<div class="painel">
    <h1>🤖 Painel do Bot de Ofertas</h1>
    <p>Monitoramento do sistema</p>

    <p>
        <a href="/ml/autorizar">Autorizar Mercado Livre</a>
    </p>

    <div class="grade">
        <div class="card">
            <div>Ofertas cadastradas</div>
            <div class="numero" id="total">--</div>
        </div>
        <div class="card">
            <div>Enviadas</div>
            <div class="numero" id="enviadas">--</div>
        </div>
        <div class="card">
            <div>Pendentes</div>
            <div class="numero" id="pendentes">--</div>
        </div>
        <div class="card">
            <div>Descartadas</div>
            <div class="numero" id="descartadas">--</div>
        </div>
    </div>

    <div class="card">
        <h2>Status dos serviços</h2>
        <p id="whatsapp">WhatsApp: verificando...</p>
        <p id="mineracao">Mineração: verificando...</p>
        <p id="banco">Banco: verificando...</p>
        <p id="mercadolivre">Mercado Livre: verificando...</p>
    </div>

    <div class="card">
        <h2>🟡 Importar produtos do Mercado Livre</h2>

        <p class="pequeno">
            Coloque abaixo uma lista JSON com os produtos que você selecionou.
            O bot vai procurar o link correspondente no arquivo
            links-mercadolivre.json. Produtos sem link cadastrado não serão enviados.
        </p>

        <p class="pequeno">
            Exemplo:
        </p>

        <textarea id="produtosML">[
  {
    "id": "MLB3670554997",
    "titulo": "Nome do produto",
    "preco": 99.90
  }
]</textarea>

        <button onclick="importarML()">Importar produtos</button>
        <button onclick="minerarML()">Processar ofertas</button>

        <p id="resultadoImportacao"></p>
    </div>

    <div class="card">
        <h2>⚙️ Controle</h2>
        <button onclick="atualizar()">Atualizar painel</button>
        <button onclick="minerar()">Iniciar mineração completa</button>
    </div>
</div>

<script>
async function atualizar() {
    try {
        const resposta = await fetch('/api/status');
        const dados = await resposta.json();

        document.getElementById('total').textContent = dados.total;
        document.getElementById('enviadas').textContent = dados.enviadas;
        document.getElementById('pendentes').textContent = dados.pendentes;
        document.getElementById('descartadas').textContent = dados.descartadas;

        document.getElementById('whatsapp').textContent =
            'WhatsApp: ' + (dados.whatsapp ? 'Conectado' : 'Desconectado');

        document.getElementById('mineracao').textContent =
            'Mineração: ' + (dados.mineracao ? 'Em andamento' : 'Aguardando');

        document.getElementById('banco').textContent =
            'Banco: ' + (dados.banco ? 'Conectado' : 'Indisponível');

        document.getElementById('mercadolivre').textContent =
            'Mercado Livre: ' + (dados.mercadolivre ? 'Token salvo' : 'Sem token');

    } catch (erro) {
        console.error(erro);
    }
}

async function importarML() {
    const resultado = document.getElementById('resultadoImportacao');

    try {
        const produtos = JSON.parse(
            document.getElementById('produtosML').value
        );

        if (!Array.isArray(produtos)) {
            throw new Error('O conteúdo precisa ser uma lista de produtos.');
        }

        const resposta = await fetch('/api/ml/importar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ produtos })
        });

        const dados = await resposta.json();

        if (!resposta.ok) {
            throw new Error(dados.erro || 'Falha na importação.');
        }

        resultado.textContent =
            'Importação concluída. Produtos recebidos: ' +
            dados.importados +
            '. Total na lista: ' +
            dados.total;

    } catch (erro) {
        resultado.textContent = 'Erro: ' + erro.message;
    }
}

async function minerar() {
    const resultado = document.getElementById('resultadoImportacao');

    try {
        const resposta = await fetch('/api/minerar', {
            method: 'POST'
        });

        const dados = await resposta.json();
        resultado.textContent = dados.mensagem || dados.erro || 'Solicitação enviada.';
    } catch (erro) {
        resultado.textContent = 'Erro: ' + erro.message;
    }
}

async function minerarML() {
    const resultado = document.getElementById('resultadoImportacao');

    try {
        const resposta = await fetch('/api/ml/processar', {
            method: 'POST'
        });

        const dados = await resposta.json();
        resultado.textContent = dados.mensagem || dados.erro || 'Solicitação enviada.';
    } catch (erro) {
        resultado.textContent = 'Erro: ' + erro.message;
    }
}

atualizar();
setInterval(atualizar, 5000);
</script>
</body>
</html>
    `);
});

// ======================================================
// ROTAS DE IMPORTAÇÃO DO MERCADO LIVRE
// ======================================================

app.post('/api/ml/importar', (req, res) => {
    try {
        const produtosRecebidos = req.body?.produtos;

        if (!Array.isArray(produtosRecebidos)) {
            return res.status(400).json({
                erro: 'Envie uma lista de produtos no campo produtos.'
            });
        }

        const atuais = carregarProdutosML();
        const mapa = new Map();

        for (const produto of atuais) {
            const id = normalizarMLB(produto.id || produto.mlb);
            if (id) mapa.set(id, produto);
        }

        let importados = 0;

        for (const produto of produtosRecebidos) {
            const id = normalizarMLB(produto.id || produto.mlb);
            const titulo = String(produto.titulo || '').trim();

            if (!id || !titulo) continue;

            const preco = Number(produto.preco);

            mapa.set(id, {
                id,
                titulo: titulo.slice(0, 300),
                preco: Number.isFinite(preco) && preco > 0
                    ? preco
                    : null
            });

            importados++;
        }

        const listaFinal = Array.from(mapa.values());

        salvarProdutosML(listaFinal);

        log(
            'MERCADO LIVRE',
            `${importados} produtos importados pelo painel.`
        );

        res.json({
            sucesso: true,
            importados,
            total: listaFinal.length,
            mensagem: 'Produtos importados com sucesso.'
        });

    } catch (erro) {
        log('ERRO IMPORTAÇÃO ML', erro.message);

        res.status(500).json({
            erro: erro.message
        });
    }
});

app.post('/api/ml/processar', async (req, res) => {
    if (mineracaoAtiva) {
        return res.status(409).json({
            erro: 'Já existe uma mineração em andamento.'
        });
    }

    executarMineracao();

    res.json({
        mensagem: 'Processamento iniciado. Consulte os logs do bot.'
    });
});

// ======================================================
// API DO PAINEL
// ======================================================

app.get('/api/status', async (req, res) => {
    try {
        const dados = await consultarSQL(`
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN postado_no_canal = 1 THEN 1 ELSE 0 END) AS enviadas,
                SUM(CASE WHEN postado_no_canal = 0 THEN 1 ELSE 0 END) AS pendentes,
                SUM(CASE WHEN postado_no_canal = 2 THEN 1 ELSE 0 END) AS descartadas
            FROM ofertas
        `);

        const token = carregarTokenML();

        res.json({
            sistema: 'online',
            banco: bancoPronto,
            whatsapp: whatsappPronto,
            mineracao: mineracaoAtiva,
            mercadolivre: Boolean(token && token.refresh_token),
            total: dados.total || 0,
            enviadas: dados.enviadas || 0,
            pendentes: dados.pendentes || 0,
            descartadas: dados.descartadas || 0,
            produtosMLImportados: carregarProdutosML().length
        });

    } catch (erro) {
        res.status(500).json({
            erro: erro.message
        });
    }
});

app.get('/api/ofertas', async (req, res) => {
    try {
        const ofertas = await consultarTodos(`
            SELECT id, texto, link_afiliado, loja,
                   postado_no_canal, data_criacao
            FROM ofertas
            ORDER BY id DESC
            LIMIT 100
        `);

        res.json(ofertas);

    } catch (erro) {
        res.status(500).json({
            erro: erro.message
        });
    }
});

app.post('/api/minerar', (req, res) => {
    if (mineracaoAtiva) {
        return res.status(409).json({
            mensagem: 'Já existe uma mineração em andamento.'
        });
    }

    executarMineracao();

    res.json({
        mensagem: 'Mineração iniciada.'
    });
});

// ======================================================
// INICIALIZAÇÃO
// ======================================================

async function iniciar() {
    try {
        await inicializarBanco();

        // Cria o arquivo de importação sem apagar conteúdo existente.
        if (!fs.existsSync(ARQUIVOS.PRODUTOS_ML)) {
            salvarProdutosML([]);
        }

        app.listen(CONFIG.PORT, () => {
            log('PAINEL', `http://localhost:${CONFIG.PORT}`);
            log(
                'OAUTH',
                `Autorização: http://localhost:${CONFIG.PORT}/ml/autorizar`
            );

            if (!CONFIG.ML_CLIENT_SECRET) {
                log(
                    'AVISO',
                    'Client Secret não foi encontrado nesta sessão do Windows.'
                );
            }

            log(
                'MERCADO LIVRE',
                'Modo de importação manual de produtos ativado.'
            );
        });

        setInterval(
            enviarOferta,
            CONFIG.INTERVALO_ENVIO
        );

        await bot.initialize();

        setTimeout(() => {
            executarMineracao();
        }, 8000);

        setInterval(() => {
            if (!mineracaoAtiva) {
                executarMineracao();
            }
        }, CONFIG.INTERVALO_BUSCA);

    } catch (erro) {
        log('FATAL', erro.stack || erro.message);
        process.exitCode = 1;
    }
}

// ======================================================
// ENCERRAMENTO
// ======================================================

let encerrando = false;

async function encerrar() {
    if (encerrando) return;

    encerrando = true;

    log('SISTEMA', 'Encerrando com segurança...');

    try {
        await bot.destroy().catch(() => {});
    } finally {
        db.close(() => {
            log('SISTEMA', 'Banco de dados fechado.');
            process.exit(0);
        });
    }
}

process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);

iniciar();
