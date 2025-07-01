// api/test-sftp-fixed.js
export default async function handler(req, res) {
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { sftpUsername, serverUrl, exportId, sshKeyContent } = req.body;
  
  try {
    // Validate required fields
    if (!sftpUsername || !serverUrl || !exportId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required SFTP configuration (username, server, exportId)' 
      });
    }

    if (!sshKeyContent) {
      return res.status(400).json({ 
        success: false, 
        error: 'SSH key content is required for Toast SFTP connection' 
      });
    }

    // Dynamic import for ssh2-sftp-client
    const { default: SftpClient } = await import('ssh2-sftp-client');
    const sftp = new SftpClient();
    
    try {
      // Clean up the SSH key - ensure proper formatting
      let cleanKey = sshKeyContent.trim();
      
      // If key doesn't have proper headers, it might be just the key data
      if (!cleanKey.includes('-----BEGIN') && !cleanKey.includes('-----END')) {
        // Try to reconstruct as OpenSSH format
        cleanKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${cleanKey}\n-----END OPENSSH PRIVATE KEY-----`;
      }
      
      // Replace escaped newlines with actual newlines
      cleanKey = cleanKey.replace(/\\n/g, '\n');
      
      // Connection configuration with multiple key format attempts
      const connectionConfigs = [
        // Try as buffer first
        {
          host: serverUrl,
          username: sftpUsername,
          privateKey: Buffer.from(cleanKey),
          algorithms: {
            kex: ['diffie-hellman-group14-sha256', 'diffie-hellman-group16-sha512'],
            cipher: ['aes128-ctr', 'aes192-ctr', 'aes256-ctr'],
            serverHostKey: ['ssh-rsa', 'ssh-ed25519'],
            hmac: ['hmac-sha2-256', 'hmac-sha2-512']
          }
        },
        // Try as string
        {
          host: serverUrl,
          username: sftpUsername,
          privateKey: cleanKey,
          algorithms: {
            kex: ['diffie-hellman-group14-sha256'],
            cipher: ['aes128-ctr'],
            serverHostKey: ['ssh-rsa'],
            hmac: ['hmac-sha2-256']
          }
        },
        // Try with passphrase as empty string
        {
          host: serverUrl,
          username: sftpUsername,
          privateKey: cleanKey,
          passphrase: '',
          algorithms: {
            kex: ['diffie-hellman-group14-sha256'],
            cipher: ['aes128-ctr'],
            serverHostKey: ['ssh-rsa'],
            hmac: ['hmac-sha2-256']
          }
        }
      ];

      let connectionError;
      let connected = false;

      // Try each configuration
      for (let i = 0; i < connectionConfigs.length; i++) {
        try {
          await sftp.connect(connectionConfigs[i]);
          connected = true;
          break;
        } catch (err) {
          connectionError = err;
          await sftp.end();
          continue;
        }
      }

      if (!connected) {
        throw connectionError;
      }
      
      // Test listing the root directory first
      const rootFiles = await sftp.list('/');
      
      // Try to list the export directory
      const exportPath = `/${exportId}/`;
      let exportFiles = [];
      let actualPath = exportPath;
      
      try {
        exportFiles = await sftp.list(exportPath);
      } catch (exportError) {
        // If exact path doesn't work, try to find it
        const possiblePaths = [
          `/${exportId}`,
          `/exports/${exportId}`,
          `/data/${exportId}`,
          exportId,
          `${exportId}/`
        ];
        
        for (const path of possiblePaths) {
          try {
            exportFiles = await sftp.list(path);
            actualPath = path;
            break;
          } catch (e) {
            continue;
          }
        }
      }

      // Get recent files (last 30 days for better chance of finding something)
      const recentFiles = exportFiles.filter(file => {
        if (!file.name || file.type === 'd') return false; // Skip directories
        const fileDate = new Date(file.modifyTime);
        const monthAgo = new Date();
        monthAgo.setDate(monthAgo.getDate() - 30);
        return fileDate > monthAgo;
      });

      // Get CSV files specifically
      const csvFiles = exportFiles.filter(file => 
        file.name && file.name.toLowerCase().includes('.csv')
      );

      await sftp.end();
      
      res.status(200).json({ 
        success: true, 
        message: 'SFTP connection successful!',
        details: {
          server: serverUrl,
          username: sftpUsername,
          exportPath: actualPath,
          rootFilesCount: rootFiles.length,
          exportFilesFound: exportFiles.length,
          recentFilesCount: recentFiles.length,
          csvFilesCount: csvFiles.length,
          sampleFiles: csvFiles.slice(0, 5).map(f => ({
            name: f.name,
            size: f.size,
            modified: new Date(f.modifyTime).toLocaleString()
          })),
          allFiles: exportFiles.slice(0, 10).map(f => ({
            name: f.name,
            type: f.type,
            size: f.size,
            modified: new Date(f.modifyTime).toLocaleString()
          }))
        }
      });
      
    } catch (connectionError) {
      await sftp.end();
      throw connectionError;
    }
    
  } catch (error) {
    console.error('SFTP test error:', error);
    res.status(500).json({ 
      success: false, 
      error: `SFTP connection failed: ${error.message}`,
      details: {
        server: serverUrl,
        username: sftpUsername,
        keyFormat: sshKeyContent ? sshKeyContent.substring(0, 50) + '...' : 'Not provided',
        troubleshooting: [
          'Try regenerating SSH key in OpenSSH format',
          'Verify server URL is correct',
          'Check username is exactly as provided by Toast',
          'Ensure export ID exists on the server',
          'Contact Toast support to verify key format'
        ]
      }
    });
  }
}
