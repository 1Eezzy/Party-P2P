# Party P2P

Aplicativo Electron de texto, voz e compartilhamento de tela entre participantes.

## Desenvolvimento

```sh
npm ci
npm start
```

Caso o npm informe que bloqueou os scripts de instalação do Electron, revise e autorize o script do pacote com `npm approve-scripts electron` e execute `npm rebuild electron`.

## Perfil e áudio

A navegação lateral oferece **Início**, **Conversas**, **Salas de voz**, **Membros**, **Atividade** e **Configurações**. O Início resume as conexões e salas reais da party. A busca filtra canais e pessoas; a aba Atividade lista as mensagens recentes disponíveis na sessão. Os controles de chamada permanecem acessíveis no topo ao trocar de aba.

O visual usa a fonte variável Manrope, distribuída localmente com a licença OFL em `assets/fonts/`. O indicador de fala usa um aro fino com halo violeta e transição de opacidade, sem rotação. A preferência de movimento reduzido do sistema é respeitada.

- Clique em **Meu perfil**, no rodapé, para escolher ou remover uma foto. Ela é salva localmente e compartilhada com os participantes conectados, aparecendo na lista de membros, na voz e nas mensagens enquanto o autor está conectado.
- A engrenagem ao lado do perfil abre **Voz e áudio**. A seleção de microfone é salva neste computador e pode ser alterada durante uma chamada.
- **Testar microfone** exibe o nível de entrada. Marque **Ouvir meu microfone** para ouvir o retorno com fones. O teste é local e termina ao fechar a janela ou mudar de aba. Uma chamada em andamento continua transmitindo normalmente.
- O círculo animado identifica a fala dos participantes na mesma sala de voz. Microfones silenciados e o áudio do compartilhamento de tela não devem ativar o círculo.
- As três barras mostram o RTT da pior conexão P2P na sala atual (ou na party quando você está fora da voz). Verde: abaixo de 100 ms; amarelo: de 100 a 199 ms; vermelho: a partir de 200 ms ou conexão interrompida. Sem outro participante, não há medição. Isso não mede velocidade de internet nem representa um diagnóstico completo da rede.

Todos precisam executar esta versão para visualizar a nova interface e seus indicadores. A escolha do dispositivo e o teste de áudio são controles locais de cada participante.

## Verificação

```sh
npm test
```

O teste abre duas instâncias ocultas e isoladas com microfones sintéticos, conectadas a um servidor local na porta 17779. Verifica sincronização/remoção de foto, voz, fala e mute, RTT, limites do indicador, troca de entrada, erro de permissão, liberação do teste de microfone e mensagens. As capturas de tela ficam em `%TEMP%/party-p2p-smoke`. Não usa o perfil real do aplicativo.

Antes de distribuir, confira também em dois computadores com microfones reais: qualidade do som, retorno com fones, troca/desconexão de dispositivo e conexão pela rede/VPN utilizada pela party.

## Atualizador Windows

O build compila um updater WinForms independente e o inclui em `resources/updater/`. Na primeira abertura, o Party P2P o copia para `%APPDATA%\Party P2P\updater\PartyP2P.Updater.exe`. O updater usa elevação UAC, download HTTPS restrito às releases oficiais, validação PE/SHA-256 (quando o GitHub fornece o digest), staging, substituição atômica com backup e rollback.

Na versão portátil, o alvo é `PORTABLE_EXECUTABLE_FILE` — o launcher real aberto pela pessoa — e não `process.execPath`, que aponta para a cópia extraída em `%TEMP%`. Falhas detalhadas ficam em `%APPDATA%\Party P2P\updater\updater.log`.

Para validar isoladamente o mecanismo de troca:

```powershell
npm run build:updater
Start-Process .\build\updater\PartyP2P.Updater.exe -ArgumentList --self-test -Wait
```

## Compartilhar o trabalho

As alterações estão na branch `codex/continuar-projeto`. Depois de revisar, envie a branch ao GitHub e abra uma pull request para o repositório original. `npm run dist` gera os pacotes Windows em `dist/`. O comando `npm run release` publica no GitHub; use apenas ao preparar uma release autorizada.
