const { getOne, runSql } = require('./db');

const onlineSockets = {}; // Mapping of username -> Set of socket IDs

function setupMessageSockets(io) {
  io.on('connection', (socket) => {
    
    // Register active user session
    socket.on('msg_register', ({ username }) => {
      if (!username) return;
      socket.msgUsername = username;
      if (!onlineSockets[username]) {
        onlineSockets[username] = new Set();
      }
      onlineSockets[username].add(socket.id);
      
      // Join global chat room
      socket.join('msg_global_lobby');
    });

    // Global message send
    socket.on('msg_global_send', async ({ senderUsername, content }) => {
      if (!senderUsername || !content) return;
      try {
        const sender = await getOne('SELECT id, display_name, role, avatar FROM users WHERE username = ?', [senderUsername]);
        if (!sender) return;

        // Insert into DB
        await runSql('INSERT INTO messages (sender_id, recipient_id, content) VALUES (?, NULL, ?)', [sender.id, content]);
        
        // Broadcast to all sockets
        io.to('msg_global_lobby').emit('msg_global_receive', {
          senderUsername,
          displayName: sender.display_name || senderUsername,
          role: sender.role,
          avatar: sender.avatar,
          content,
          created_at: new Date().toISOString()
        });
      } catch (err) {
        console.error('msg_global_send error:', err);
      }
    });

    // Private message send
    socket.on('msg_private_send', async ({ senderUsername, recipientUsername, content }) => {
      if (!senderUsername || !recipientUsername || !content) return;
      try {
        const sender = await getOne('SELECT id, display_name, role, avatar FROM users WHERE username = ?', [senderUsername]);
        const recipient = await getOne('SELECT id FROM users WHERE username = ?', [recipientUsername]);
        if (!sender || !recipient) return;

        // Insert into DB
        await runSql('INSERT INTO messages (sender_id, recipient_id, content) VALUES (?, ?, ?)', [sender.id, recipient.id, content]);

        const payload = {
          sender_username: senderUsername,
          sender_display_name: sender.display_name || senderUsername,
          sender_role: sender.role,
          sender_avatar: sender.avatar,
          recipient_username: recipientUsername,
          content,
          created_at: new Date().toISOString()
        };

        // Send to recipient if online
        const recipientSocketIds = onlineSockets[recipientUsername];
        if (recipientSocketIds) {
          recipientSocketIds.forEach(socketId => {
            io.to(socketId).emit('msg_private_receive', payload);
          });
        }

        // Send back to all sender's active sockets (for multi-tab synchronization!)
        const senderSocketIds = onlineSockets[senderUsername];
        if (senderSocketIds) {
          senderSocketIds.forEach(socketId => {
            io.to(socketId).emit('msg_private_receive', payload);
          });
        }
      } catch (err) {
        console.error('msg_private_send error:', err);
      }
    });

    // Typing state synchronization
    socket.on('msg_typing', ({ senderUsername, recipientUsername, isTyping }) => {
      if (!senderUsername) return;
      
      if (recipientUsername) {
        // DM typing indicator: only send to recipient
        const recipientSocketIds = onlineSockets[recipientUsername];
        if (recipientSocketIds) {
          recipientSocketIds.forEach(socketId => {
            io.to(socketId).emit('msg_typing_receive', { senderUsername, recipientUsername, isTyping });
          });
        }
      } else {
        // Global typing indicator: send to everyone in the lobby
        socket.to('msg_global_lobby').emit('msg_typing_receive', { senderUsername, recipientUsername: null, isTyping });
      }
    });

    // Clean up
    socket.on('disconnect', () => {
      const username = socket.msgUsername;
      if (username && onlineSockets[username]) {
        onlineSockets[username].delete(socket.id);
        if (onlineSockets[username].size === 0) {
          delete onlineSockets[username];
        }
      }
    });
  });
}

module.exports = { setupMessageSockets };
