const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// Armazenar usuários que estão aguardando
let waitingUsers = []; // [{ socketId: string, username: string }]

// Armazenar pares ativos e suas salas
// Map<socket.id, { peerId: string, roomName: string }>
let activePairs = new Map();

app.use(express.static(__dirname + '/')); // Serve arquivos estáticos

io.on('connection', (socket) => {
    console.log(`[SERVER] Usuário conectado: ${socket.id}`);

    // Quando um usuário define seu nome
    socket.on('set_username', (username) => {
        socket.username = username; // Atribui o username ao objeto socket
        console.log(`[SERVER] Usuário ${socket.id} definido como ${username}`);
    });

    // Quando um usuário procura por um par (inicia ou avança chamada)
    socket.on('find_peer', () => {
        if (!socket.username) {
            socket.emit('error_message', 'Por favor, defina seu nome de usuário primeiro.');
            console.warn(`[SERVER] Usuário ${socket.id} tentou encontrar par sem username.`);
            return;
        }

        // Se o usuário já está em uma chamada ativa, desconecte-o primeiro.
        // Isso é importante para a funcionalidade "Próxima Chamada".
        if (activePairs.has(socket.id)) {
            const { peerId, roomName } = activePairs.get(socket.id);
            if (peerId) {
                // Notifica o outro par
                io.to(peerId).emit('peer_disconnected');
            }
            socket.leave(roomName);
            activePairs.delete(socket.id);
            activePairs.delete(peerId); // Limpa o par do outro lado também
            console.log(`[SERVER] Usuário ${socket.username} (${socket.id}) saiu da sala ${roomName} para procurar novo par.`);
        }

        // Remove o usuário de waitingUsers se ele já estava lá por algum motivo
        waitingUsers = waitingUsers.filter(u => u.socketId !== socket.id);

        // Tenta encontrar um par
        if (waitingUsers.length > 0) {
            const potentialPeer = waitingUsers.shift(); // Pega o primeiro da fila
            const peerSocket = io.sockets.sockets.get(potentialPeer.socketId); // Obtém o objeto socket real

            // Verifica se o peer ainda está conectado e não é o mesmo usuário
            if (peerSocket && peerSocket.connected && peerSocket.id !== socket.id) {
                const roomName = `${socket.id}_${peerSocket.id}`;
                socket.join(roomName);
                peerSocket.join(roomName);

                activePairs.set(socket.id, { peerId: peerSocket.id, roomName: roomName });
                activePairs.set(peerSocket.id, { peerId: socket.id, roomName: roomName });

                // Notifica ambos os usuários que a chamada foi iniciada
                io.to(socket.id).emit('call_started', {
                    room: roomName,
                    peerId: peerSocket.id,
                    peerUsername: peerSocket.username,
                    initiator: true // Este cliente é o "iniciador" da oferta WebRTC
                });
                io.to(peerSocket.id).emit('call_started', {
                    room: roomName,
                    peerId: socket.id,
                    peerUsername: socket.username,
                    initiator: false // Este cliente aguarda a oferta
                });

                console.log(`[SERVER] Chamada iniciada: ${socket.username} (${socket.id}) e ${peerSocket.username} (${peerSocket.id}) na sala ${roomName}`);
            } else {
                // Se o peer que saiu da fila não está mais conectado ou é inválido, tenta novamente.
                console.log(`[SERVER] Peer ${potentialPeer.socketId} desconectado ou inválido. Recolocando ${socket.id} na fila.`);
                socket.emit('waiting_for_peer'); // Este cliente ainda espera
                waitingUsers.push({ socketId: socket.id, username: socket.username }); // Coloca de volta na fila
            }
        } else {
            // Nenhum usuário esperando, este usuário vai esperar
            waitingUsers.push({ socketId: socket.id, username: socket.username });
            socket.emit('waiting_for_peer');
            console.log(`[SERVER] Usuário ${socket.username} (${socket.id}) esperando por um par.`);
        }
    });

    // Eventos de sinalização WebRTC (passar dados entre os pares)
    socket.on('signal', (data) => {
        const pairInfo = activePairs.get(socket.id);
        // Apenas retransmite o sinal se o destinatário for realmente o par atual do remetente
        if (pairInfo && pairInfo.peerId === data.to) {
            io.to(data.to).emit('signal', {
                from: socket.id,
                username: socket.username, // Inclui o nome de usuário para o cliente
                type: data.type,
                payload: data.payload
            });
            // console.log(`[SERVER] Sinal ${data.type} de ${socket.id} para ${data.to}`);
        } else {
            console.warn(`[SERVER] Sinal inválido ou para par incorreto: ${socket.id} -> ${data.to}. Tipo: ${data.type}`);
        }
    });

    // Evento de chat de texto
    socket.on('chat_message', (message) => {
        const pairInfo = activePairs.get(socket.id);
        if (pairInfo) {
            // Envia a mensagem para todos na sala do remetente (ou seja, ambos os pares)
            io.to(pairInfo.roomName).emit('chat_message', { sender: socket.username, message: message });
            console.log(`[SERVER] Mensagem de chat na sala ${pairInfo.roomName}: ${socket.username}: ${message}`);
        }
    });

    // Quando um usuário desliga a chamada (hangUp)
    socket.on('hang_up', () => {
        const pairInfo = activePairs.get(socket.id);
        if (pairInfo) {
            socket.leave(pairInfo.roomName);
            // Notifica o outro par sobre a desconexão
            io.to(pairInfo.peerId).emit('peer_disconnected');
            // Remove as entradas do mapa de pares
            activePairs.delete(pairInfo.peerId);
            activePairs.delete(socket.id);
            console.log(`[SERVER] Usuário ${socket.username} (${socket.id}) desconectou da sala ${pairInfo.roomName}.`);
        } else {
            // Se o usuário não estava em um par ativo, ele pode estar na fila de espera
            waitingUsers = waitingUsers.filter(u => u.socketId !== socket.id);
            console.log(`[SERVER] Usuário ${socket.username} (${socket.id}) saiu da fila de espera.`);
        }
    });

    // Quando um usuário se desconecta completamente do servidor Socket.IO
    socket.on('disconnect', () => {
        console.log(`[SERVER] Usuário desconectado: ${socket.id}`);

        // Remove da fila de espera se estiver lá
        waitingUsers = waitingUsers.filter(user => user.socketId !== socket.id);

        // Se estava em uma chamada ativa, notifica o par
        const pairInfo = activePairs.get(socket.id);
        if (pairInfo) {
            io.to(pairInfo.peerId).emit('peer_disconnected');
            activePairs.delete(pairInfo.peerId);
            activePairs.delete(socket.id);
            console.log(`[SERVER] Par de ${socket.username} (${socket.id}) desconectado inesperadamente.`);
        }
    });
});

server.listen(PORT, () => {
    console.log(`[SERVER] Servidor rodando em http://localhost:${PORT}`);
});