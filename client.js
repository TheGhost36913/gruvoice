document.addEventListener('DOMContentLoaded', () => {
    // Referências aos elementos do DOM
    const localVideo = document.getElementById('localVideo');
    const remoteVideo = document.getElementById('remoteVideo');
    const usernameInput = document.getElementById('usernameInput');
    const joinLobbyButton = document.getElementById('joinLobbyButton');
    const userSetupSection = document.querySelector('.user-setup-section');
    const liveSection = document.querySelector('.live-section');
    const localUsernameSpan = document.getElementById('localUsername');
    const remoteUsernameSpan = document.getElementById('remoteUsername');
    const setupStatus = document.getElementById('setupStatus');

    const nextCallButton = document.getElementById('nextCallButton');
    const hangUpButton = document.getElementById('hangUpButton');
    const toggleAudioButton = document.getElementById('toggleAudio');
    const toggleVideoButton = document.getElementById('toggleVideo');
    const messageInput = document.getElementById('messageInput');
    const sendMessageButton = document.getElementById('sendMessage');
    const messagesDiv = document.getElementById('messages');

    // Variáveis de estado global
    let localStream; // O stream de vídeo/áudio local
    let peerConnection; // A conexão WebRTC
    let socket = io(); // A conexão Socket.IO com o servidor
    let remotePeerId = null; // ID do socket do outro par
    let dataChannel; // Canal de dados WebRTC para chat de texto
    let currentUsername = ''; // Nome de usuário do cliente atual

    // Configuração dos STUN servers (públicos e gratuitos)
    // STUN servers ajudam os pares a descobrir seus IPs públicos para estabelecer a conexão direta.
    // Para produção, considere usar seus próprios STUN/TURN servers ou um serviço pago.
    const iceServers = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' },
        ]
    };

    // --- Funções de Manipulação da UI ---

    // Alterna a visibilidade das seções de configuração e da live
    function toggleSectionVisibility(showLiveSection) {
        if (showLiveSection) {
            userSetupSection.classList.add('hidden');
            liveSection.classList.remove('hidden');
            liveSection.classList.add('visible'); // Adiciona classe para exibir com flex
        } else {
            userSetupSection.classList.remove('hidden');
            liveSection.classList.remove('visible');
            liveSection.classList.add('hidden'); // Garante que esteja escondido
        }
    }

    // Atualiza o estado dos botões de controle de chamada
    function updateCallButtons(inCall) {
        nextCallButton.disabled = inCall;
        hangUpButton.disabled = !inCall;
    }

    // Adiciona uma mensagem ao chat
    function addMessage(msg, type = 'info', sender = 'Sistema') {
        const p = document.createElement('p');
        p.textContent = `${sender}: ${msg}`;
        p.classList.add(type);
        messagesDiv.appendChild(p);
        messagesDiv.scrollTop = messagesDiv.scrollHeight; // Rola para a mensagem mais recente
    }

    // Exibe uma mensagem de status na seção de setup
    function showSetupStatus(message, type = 'info') {
        setupStatus.textContent = message;
        setupStatus.className = 'status-message ' + type; // Limpa classes anteriores e adiciona nova
    }

    // --- Lógica WebRTC ---

    // Tenta iniciar o stream de vídeo e áudio local (câmera e microfone)
    async function startLocalStream() {
        if (localStream) { // Se já temos um stream local, apenas retornamos
            localVideo.srcObject = localStream;
            return;
        }
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            localVideo.srcObject = localStream;
            toggleAudioButton.textContent = 'Mic ON';
            toggleVideoButton.textContent = 'Cam ON';
            addMessage('Câmera e microfone acessados com sucesso!', 'success');
            // Habilita os botões de controle de mídia, pois há um stream
            toggleAudioButton.disabled = false;
            toggleVideoButton.disabled = false;
        } catch (error) {
            console.error('Erro ao acessar câmera/microfone:', error);
            alert('Não foi possível acessar sua câmera e microfone. Verifique as permissões do navegador e tente novamente.');
            addMessage('Erro: Não foi possível iniciar o stream local. Verifique as permissões.', 'error');
            // Desabilita botões se o acesso falhar
            toggleAudioButton.disabled = true;
            toggleVideoButton.disabled = true;
            // Impede de procurar par se não há stream
            nextCallButton.disabled = true;
            hangUpButton.disabled = true;
            return false; // Indica que o stream não foi iniciado
        }
        return true; // Indica que o stream foi iniciado com sucesso
    }

    // Cria/reinicializa a RTCPeerConnection para uma nova chamada
    function initializePeerConnection(peerId, peerUsername) {
        // Se já existe uma conexão, fecha-a para evitar estados conflitantes
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
            console.log('[CLIENT] Fechando conexão peer anterior.');
        }

        peerConnection = new RTCPeerConnection(iceServers);
        remotePeerId = peerId;
        remoteUsernameSpan.textContent = peerUsername;
        addMessage(`Conectando com ${peerUsername}...`, 'info');

        // Adiciona as tracks de áudio/vídeo locais ao peerConnection
        if (localStream) {
            localStream.getTracks().forEach(track => {
                peerConnection.addTrack(track, localStream);
                console.log(`[CLIENT] Track local adicionada: ${track.kind}`);
            });
        } else {
            console.warn('[CLIENT] Stream local não disponível ao adicionar tracks. A chamada pode falhar.');
            addMessage('Aviso: Seu vídeo/áudio pode não ser enviado. Tente reiniciar.', 'warning');
        }

        // Evento: Quando o peer remoto adiciona uma track (recebemos o vídeo/áudio dele)
        peerConnection.ontrack = (event) => {
            if (remoteVideo.srcObject !== event.streams[0]) {
                remoteVideo.srcObject = event.streams[0];
                addMessage('Vídeo e áudio remoto recebidos!', 'success');
            }
        };

        // Evento: Quando o peerConnection gera um candidato ICE (informações de rede)
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                // Envia o candidato ICE para o outro par via servidor de sinalização
                socket.emit('signal', {
                    to: remotePeerId,
                    type: 'candidate',
                    payload: event.candidate
                });
                // console.log('[CLIENT] Enviando candidato ICE:', event.candidate);
            }
        };

        // Evento: Acompanha o estado da conexão WebRTC
        peerConnection.onconnectionstatechange = () => {
            console.log('[CLIENT] PeerConnection state:', peerConnection.connectionState);
            if (peerConnection.connectionState === 'connected') {
                addMessage('Conexão P2P estabelecida!', 'success');
            } else if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed') {
                addMessage('Conexão P2P perdida ou falhou. Tentando reconectar...', 'warning');
                // Em um cenário real, você pode tentar renegociar ou simplesmente chamar endCall()
            } else if (peerConnection.connectionState === 'closed') {
                addMessage('Conexão P2P fechada.', 'info');
            }
        };

        // --- Data Channel para Chat de Texto ---
        // Cria o Data Channel. Será usado pelo cliente que INICIA a oferta.
        dataChannel = peerConnection.createDataChannel('chat');
        dataChannel.onmessage = (event) => addMessage(event.data, 'received', remoteUsernameSpan.textContent);
        dataChannel.onopen = () => {
            addMessage('Canal de mensagens aberto!', 'info');
            sendMessageButton.disabled = false;
            messageInput.disabled = false;
        };
        dataChannel.onclose = () => {
            addMessage('Canal de mensagens fechado.', 'info');
            sendMessageButton.disabled = true;
            messageInput.disabled = true;
        };
        dataChannel.onerror = (error) => {
            console.error('[CLIENT] Erro no canal de dados:', error);
            addMessage('Erro no canal de mensagens.', 'error');
        };

        // Evento: Recebe o Data Channel do outro peer (para quem RECEBE a oferta).
        peerConnection.ondatachannel = (event) => {
            dataChannel = event.channel;
            dataChannel.onmessage = (event) => addMessage(event.data, 'received', remoteUsernameSpan.textContent);
            dataChannel.onopen = () => {
                addMessage('Canal de mensagens aberto!', 'info');
                sendMessageButton.disabled = false;
                messageInput.disabled = false;
            };
            dataChannel.onclose = () => {
                addMessage('Canal de mensagens fechado.', 'info');
                sendMessageButton.disabled = true;
                messageInput.disabled = true;
            };
            dataChannel.onerror = (error) => {
                console.error('[CLIENT] Erro no canal de dados:', error);
                addMessage('Erro no canal de mensagens.', 'error');
            };
        };

        updateCallButtons(true); // Estamos em uma chamada ativa
        messagesDiv.innerHTML = ''; // Limpa mensagens anteriores
        addMessage('Iniciando negociação WebRTC...', 'info');
    }

    // Cria e envia a oferta SDP
    async function sendOffer() {
        try {
            if (!peerConnection) {
                console.error('[CLIENT] sendOffer: peerConnection não inicializada.');
                addMessage('Erro interno: Conexão P2P não pronta para enviar oferta.', 'error');
                return;
            }

            // Aguarda o estado estável para garantir que não há negociações pendentes
            if (peerConnection.signalingState !== 'stable') {
                console.warn('[CLIENT] sendOffer: Estado de sinalização não é stable. Aguardando...');
                await new Promise(resolve => {
                    peerConnection.addEventListener('signalingstatechange', function handler() {
                        if (peerConnection.signalingState === 'stable') {
                            peerConnection.removeEventListener('signalingstatechange', handler);
                            resolve();
                        }
                    });
                });
            }

            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer); // Define sua própria descrição
            socket.emit('signal', {
                to: remotePeerId,
                type: 'offer',
                payload: offer
            });
            addMessage('Oferta de conexão enviada.', 'info');
        } catch (error) {
            console.error('[CLIENT] Erro ao criar/enviar oferta:', error);
            addMessage('Erro ao iniciar a oferta de conexão. Tente novamente.', 'error');
        }
    }

    // Lida com os sinais recebidos do servidor (oferta, resposta, candidatos ICE)
    async function handleSignal(data) {
        // Se ainda não temos uma conexão P2P com este par, inicializa uma nova
        if (!peerConnection || remotePeerId !== data.from) {
             initializePeerConnection(data.from, data.username || 'Usuário Remoto');
        }

        try {
            if (data.type === 'offer') {
                // Se receber uma oferta, define como descrição remota e cria uma resposta
                await peerConnection.setRemoteDescription(new RTCSessionDescription(data.payload));
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer); // Define sua própria resposta
                socket.emit('signal', {
                    to: data.from,
                    type: 'answer',
                    payload: answer
                });
                addMessage('Oferta recebida, enviando resposta.', 'info');
            } else if (data.type === 'answer') {
                // Se receber uma resposta, define como descrição remota
                // Crucial: A descrição local (sua oferta) deve estar definida primeiro.
                if (peerConnection.localDescription && peerConnection.localDescription.type === 'offer') {
                    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.payload));
                    addMessage('Resposta recebida, conexão WebRTC estabelecida!', 'success');
                } else {
                    console.warn('[CLIENT] Resposta recebida em estado inesperado (sem oferta local). Ignorando ou atrasando.', data.payload);
                    addMessage('Aviso: Resposta fora de sequência. Pode haver um atraso na conexão.', 'warning');
                    // Em um cenário real, você pode precisar de uma lógica mais avançada para gerenciar a ordem dos sinais.
                }
            } else if (data.type === 'candidate') {
                // Adiciona candidatos ICE. Só faz sentido após a descrição remota (oferta/resposta) estar definida.
                if (peerConnection.remoteDescription) {
                    try {
                        await peerConnection.addIceCandidate(new RTCIceCandidate(data.payload));
                        // console.log('[CLIENT] Candidato ICE adicionado.');
                    } catch (e) {
                        // Pode ocorrer se o candidato já foi adicionado ou é inválido
                        console.warn('[CLIENT] Erro ao adicionar candidato ICE:', e);
                    }
                } else {
                    console.warn('[CLIENT] Candidato ICE recebido antes da descrição remota. Ignorando por agora.', data.payload);
                    // Em produção, esses candidatos podem precisar ser armazenados e adicionados depois.
                }
            }
        } catch (error) {
            console.error(`[CLIENT] Erro ao lidar com sinal ${data.type}:`, error);
            addMessage(`Erro grave ao processar sinal (${data.type}).`, 'error');
        }
    }

    // Finaliza a chamada atual, limpando o estado do WebRTC
    function endCall() {
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
        // Não paramos o stream local, pois o usuário pode querer uma próxima chamada rapidamente.
        // remoteVideo.srcObject = null;
        remoteUsernameSpan.textContent = 'Ninguém conectado';
        remoteVideo.srcObject = null; // Garante que o vídeo remoto pare de exibir
        remotePeerId = null;
        if (dataChannel) {
            dataChannel.close();
            dataChannel = null;
        }
        addMessage('Chamada encerrada.', 'info');
        updateCallButtons(false);
        messagesDiv.innerHTML = ''; // Limpa mensagens do chat
        sendMessageButton.disabled = true;
        messageInput.disabled = true;
    }

    // --- Event Listeners dos Botões ---

    joinLobbyButton.addEventListener('click', async () => {
        const username = usernameInput.value.trim();
        if (username) {
            currentUsername = username;
            socket.emit('set_username', currentUsername); // Informa o username ao servidor
            showSetupStatus('Acessando câmera e microfone...', 'info');

            const streamStarted = await startLocalStream(); // Tenta iniciar o stream local
            if (streamStarted) {
                toggleSectionVisibility(true); // Mostra a seção da live
                socket.emit('find_peer'); // Procura um par se o stream local for OK
                addMessage('Procurando por um par...', 'info');
                nextCallButton.disabled = false; // Habilita o botão "Próxima Chamada"
            } else {
                showSetupStatus('Falha ao iniciar vídeo/áudio. Verifique as permissões.', 'error');
            }
        } else {
            showSetupStatus('Por favor, digite seu nome de usuário!', 'warning');
            usernameInput.focus();
        }
    });

    nextCallButton.addEventListener('click', () => {
        if (localStream) { // Só permite nova chamada se o stream local estiver ativo
            socket.emit('hang_up'); // Notifica o servidor para desconectar o par atual
            endCall(); // Limpa o estado local para uma nova conexão
            socket.emit('find_peer'); // Procura um novo par imediatamente
            addMessage('Procurando um novo par...', 'info');
        } else {
            addMessage('Por favor, inicie seu vídeo/áudio primeiro (clique em "Entrar na Live").', 'warning');
        }
    });

    hangUpButton.addEventListener('click', () => {
        socket.emit('hang_up'); // Notifica o servidor e o outro par
        endCall(); // Finaliza a conexão local
        addMessage('Você encerrou a chamada.', 'info');
        nextCallButton.disabled = false; // Permite iniciar uma nova chamada
    });

    toggleAudioButton.addEventListener('click', () => {
        if (localStream && localStream.getAudioTracks().length > 0) {
            localStream.getAudioTracks()[0].enabled = !localStream.getAudioTracks()[0].enabled;
            toggleAudioButton.textContent = localStream.getAudioTracks()[0].enabled ? 'Mic ON' : 'Mic OFF';
            addMessage(`Microfone ${localStream.getAudioTracks()[0].enabled ? 'ativado' : 'desativado'}.`, 'info', 'Você');
        } else {
            addMessage('Nenhum microfone disponível.', 'warning');
        }
    });

    toggleVideoButton.addEventListener('click', () => {
        if (localStream && localStream.getVideoTracks().length > 0) {
            localStream.getVideoTracks()[0].enabled = !localStream.getVideoTracks()[0].enabled;
            toggleVideoButton.textContent = localStream.getVideoTracks()[0].enabled ? 'Cam ON' : 'Cam OFF';
            addMessage(`Câmera ${localStream.getVideoTracks()[0].enabled ? 'ativada' : 'desativada'}.`, 'info', 'Você');
        } else {
            addMessage('Nenhuma câmera disponível.', 'warning');
        }
    });

    sendMessageButton.addEventListener('click', () => {
        const message = messageInput.value.trim();
        if (message !== '') {
            if (dataChannel && dataChannel.readyState === 'open') {
                dataChannel.send(message);
                addMessage(message, 'sent', currentUsername);
            } else {
                // Fallback para enviar via Socket.IO se o DataChannel não estiver pronto
                // (O WebRTC DataChannel é preferível para chat de texto em p2p)
                socket.emit('chat_message', message);
                addMessage(message, 'sent', currentUsername);
            }
            messageInput.value = ''; // Limpa o input
        }
    });

    messageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            sendMessageButton.click();
        }
    });

    // --- Eventos do Socket.IO ---

    socket.on('waiting_for_peer', () => {
        addMessage('Nenhum par disponível. Aguardando outro usuário...', 'info');
        nextCallButton.disabled = false; // Permite que o usuário clique em "Próxima Chamada" para tentar de novo
        hangUpButton.disabled = true;
    });

    socket.on('call_started', (data) => {
        addMessage(`Conectado com ${data.peerUsername}!`, 'success');
        initializePeerConnection(data.peerId, data.peerUsername); // Cria/reinicializa a PeerConnection para o novo par

        // O cliente que é o "iniciador" (definido pelo servidor) envia a oferta
        if (data.initiator) {
            sendOffer();
        } else {
            addMessage(`Aguardando oferta de ${data.peerUsername}.`, 'info');
        }
        updateCallButtons(true);
    });

    // Recebe sinais de sinalização (oferta, resposta, candidatos ICE)
    socket.on('signal', (data) => {
        handleSignal(data);
    });

    // Recebe mensagens de chat (pode vir via Socket.IO ou DataChannel, dependendo da implementação)
    socket.on('chat_message', (data) => {
        // Exibe a mensagem apenas se não foi você quem enviou (para evitar duplicidade)
        if (data.sender !== currentUsername) {
            addMessage(data.message, 'received', data.sender);
        }
    });

    // Quando o par desconecta
    socket.on('peer_disconnected', () => {
        addMessage('Seu par desconectou.', 'warning');
        endCall(); // Finaliza a conexão local
        // Opcional: Para simular o Omegle, você pode iniciar a busca por um novo par automaticamente
        // socket.emit('find_peer');
        // addMessage('Procurando um novo par automaticamente...', 'info');
    });

    // Erros gerais do servidor ou lógica
    socket.on('error_message', (msg) => {
        alert('Erro: ' + msg);
        addMessage(msg, 'error');
        showSetupStatus(msg, 'error'); // Mostra no setup se estiver lá
    });

    // --- Inicialização ao Carregar a Página ---
    // Botões de controle de mídia inicialmente desabilitados até o stream local ser obtido
    toggleAudioButton.disabled = true;
    toggleVideoButton.disabled = true;
    sendMessageButton.disabled = true;
    messageInput.disabled = true;

    // Garante que os botões de chamada estão no estado correto no início
    updateCallButtons(false);
    showSetupStatus('Digite seu nome e clique "Entrar na Live".', 'info');
});