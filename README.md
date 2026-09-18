# YouTube Super Comments 💬▶️

Extensão para o Google Chrome que detecta comentários do YouTube contendo timestamps (ex: `2:24`, `01:15:30`) e os exibe diretamente sobre o player de vídeo no exato momento citado.

---

## ✨ Funcionalidades

- 🔍 **Detecção automática** de comentários com timestamps (formatos: `M:SS`, `MM:SS`, `H:MM:SS`)
- 🎬 **Overlay dentro do player** — aparece no canto inferior esquerdo, inclusive em tela cheia
- 🎨 **Design Glassmorphism** com foto do autor, nome, badge de tempo e texto do comentário
- 🚀 **Animação Pop-in** com efeito de salto elástico ao entrar
- 🌫️ **Fade-out suave** após o tempo configurável (4s a 20s)
- ⏩ **Barra de progresso** visual no card indicando quanto tempo ele ainda ficará visível
- 📋 **Popup da extensão** listando todos os timestamps encontrados (clique para pular ao momento)
- ⏯️ **Toggle** para ativar/desativar a extensão sem recarregar a página
- 🔄 **Compatível com SPA do YouTube** — funciona ao navegar entre vídeos sem recarregar

---

## 📦 Como Instalar (Modo Desenvolvedor)

> A extensão ainda não está publicada na Chrome Web Store. Siga os passos abaixo para carregá-la localmente.

### Pré-requisitos
- Google Chrome (versão 114 ou superior recomendada)

### Passo a Passo

1. **Abra o Google Chrome** e navegue para:
   ```
   chrome://extensions
   ```

2. **Ative o Modo do Desenvolvedor** — clique no toggle no canto superior direito da página.

3. **Clique em "Carregar sem compactação"** (*Load unpacked*).

4. **Selecione a pasta** do projeto:
   ```
   /opt/lampp/htdocs/super-yt-comments/
   ```

5. A extensão aparecerá na lista com o ícone 🎬💬. **Pronto!**

---

## 🚀 Como Usar

1. Acesse [youtube.com](https://www.youtube.com) e abra qualquer vídeo.
2. Role a página para baixo e aguarde os comentários carregarem.
3. Os comentários com timestamps detectados aparecerão automaticamente no player no momento citado.
4. Clique no **ícone da extensão** na barra do Chrome para ver a lista de timestamps e clicar para pular direto para o momento.

---

## ⚙️ Configurações (via Popup)

| Opção | Descrição |
|:---|:---|
| **Ativo / Inativo** | Toggle para ativar/desativar os overlays |
| **Duração** | Tempo que cada card permanece visível (4s – 20s) |
| **Lista de timestamps** | Clique num item para pular ao momento do vídeo |
| **↻ Atualizar** | Força uma nova varredura dos comentários carregados |

---

## 🗂️ Estrutura de Arquivos

```
super-yt-comments/
├── manifest.json        ← Configuração da extensão (Manifest V3)
├── content.js           ← Script injetado nas páginas do YouTube
├── styles.css           ← Estilos do overlay e animações
├── popup.html           ← Interface do popup
├── popup.js             ← Lógica do popup
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## 🔧 Notas Técnicas

- Utiliza **Manifest V3** (padrão atual do Chrome).
- Não requer permissões de rede externas — toda a coleta de dados é feita diretamente do DOM da página.
- Compatível com o layout de comentários **clássico** (`ytd-comment-renderer`) e **novo** (`ytd-comment-view-model`).
- O overlay é injetado dentro do elemento `.html5-video-player` para garantir visibilidade em modo tela cheia.

---

## 📝 Changelog

Veja [ChangeLog.txt](ChangeLog.txt).

---

*Desenvolvido com ❤️ — Super YouTube Comments v1.0.0*
