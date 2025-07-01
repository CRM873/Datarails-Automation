// api/test-sftp.js
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

    // Dynamic import for ssh2-sftp-client
    const { default: SftpClient } = await import('ssh2-sftp-client');
    const sftp = new SftpClient();
    
    try {
      // Connection configuration
      const connectionConfig = {
        host: serverUrl,
        username: sftpUsername,
        algorithms: {
          kex: ['diffie-hellman-group14-sha256', 'diffie-hellman-group16-sha512'],
          cipher: ['aes128-ctr', 'aes192-ctr', 'aes256-ctr'],
          serverHostKey: ['ssh-rsa', 'ssh-ed25519'],
          hmac: ['hmac-sha2-256', 'hmac-sha2-512']
        }
      };

      // Add SSH key if provided
      if (sshKeyContent) {
        connectionConfig.privateKey = sshKeyContent;
      } else {
        // For testing, we'll try password-based auth
        // Note: Toast typically uses key-based auth
        return res.status(400).json({ 
          success: false, 
          error: 'SSH key content is required for Toast SFTP connection' 
        });
      }

      // Connect to Toast SFTP
      await sftp.connect(connectionConfig);
      
      // Test listing the root directory first
      const rootFiles = await sftp.list('/');
      
      // Try to list the export directory
      const exportPath = `/${exportId}/`;
      let exportFiles = [];
      
      try {
        exportFiles = await sftp.list(exportPath);
      } catch (exportError) {
        // If exact path doesn't work, try to find it
        const possiblePaths = [
          `/${exportId}`,
          `/exports/${exportId}`,
          `/data/${exportId}`,
          exportId
        ];
        
        for (const path of possiblePaths) {
          try {
            exportFiles = await sftp.list(path);
            break;
          } catch (e) {
            continue;
          }
        }
      }

      // Get recent files (last 7 days)
      const recentFiles = exportFiles.filter(file => {
        const fileDate = new Date(file.modifyTime);
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);
        return fileDate > weekAgo && file.name.includes('.csv');
      });

      await sftp.end();
      
      res.status(200).json({ 
        success: true, 
        message: 'SFTP connection successful',
        details: {
          server: serverUrl,
          username: sftpUsername,
          exportPath: exportPath,
          rootFilesCount: rootFiles.length,
          exportFilesFound: exportFiles.length,
          recentCsvFiles: recentFiles.length,
          sampleFiles: recentFiles.slice(0, 5).map(f => ({
            name: f.name,
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
        troubleshooting: [
          'Verify server URL is correct',
          'Check username is exactly as provided by Toast',
          'Ensure SSH key is valid and has proper permissions',
          'Confirm export ID exists on the server'
        ]
      }
    });
  }
}
