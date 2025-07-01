// Replace your api/test-sftp.js with this (based on the working version)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { sftpUsername, serverUrl, exportId, sshKeyContent, startDate, endDate } = req.body;
  
  try {
    if (!sftpUsername || !serverUrl || !exportId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required SFTP configuration (username, server, exportId)' 
      });
    }

    // Use environment variable for SSH key if not provided in request
    const privateKey = sshKeyContent || process.env.TOAST_SSH_PRIVATE_KEY;
    
    if (!privateKey) {
      return res.status(400).json({ 
        success: false, 
        error: 'SSH key not found. Either provide sshKeyContent or set TOAST_SSH_PRIVATE_KEY environment variable' 
      });
    }

    const { default: SftpClient } = await import('ssh2-sftp-client');
    const sftp = new SftpClient();
    
    try {
      // Clean up the SSH key - ensure proper formatting
      let cleanKey = privateKey.trim();
      
      if (!cleanKey.includes('-----BEGIN') && !cleanKey.includes('-----END')) {
        cleanKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${cleanKey}\n-----END OPENSSH PRIVATE KEY-----`;
      }
      
      cleanKey = cleanKey.replace(/\\n/g, '\n');
      
      // Use the EXACT same connection logic that worked before
      const connectionConfigs = [
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
      
      // Test for single day - today (July 1st, 2025)
      const today = new Date('2025-07-01'); // Force today's date for testing
      
      const start = startDate ? new Date(startDate) : today;
      const end = endDate ? new Date(endDate) : today;
      
      // Generate YYYYMMDD formatted dates for just the test period
      const searchDates = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const yyyymmdd = d.getFullYear() + 
                         String(d.getMonth() + 1).padStart(2, '0') + 
                         String(d.getDate()).padStart(2, '0');
        searchDates.push(yyyymmdd);
      }
      
      // Focus on Toast's documented structure for today: /{export_id}/{YYYYMMDD}/
      const searchPaths = [
        `/${exportId}/`,                          // Root export directory
      ];
      
      // Add today's specific paths
      searchDates.forEach(date => {
        searchPaths.push(`/${exportId}/${date}/`);
      });
      
      // Add a few alternative structures for completeness
      searchPaths.push(
        `/${exportId}/2025/07/01/`,               // Full date path
        `/${exportId}/daily/`,                    // Daily exports folder
        `/exports/${exportId}/`,                  // Alternative root
      );

      let allFiles = [];
      let foundPaths = [];

      // Check each possible path
      for (const path of searchPaths) {
        try {
          const files = await sftp.list(path);
          if (files && files.length > 0) {
            foundPaths.push(path);
            
            const filesWithPath = files.map(file => ({
              ...file,
              fullPath: path + file.name,
              searchPath: path
            }));
            
            allFiles = allFiles.concat(filesWithPath);
          }
        } catch (e) {
          continue;
        }
      }

      // Filter files by date range
      const dateRangeFiles = allFiles.filter(file => {
        if (!file.modifyTime) return false;
        const fileDate = new Date(file.modifyTime);
        return fileDate >= start && fileDate <= end;
      });

      // Look for CSV files
      const csvFiles = allFiles.filter(file => 
        file.name && file.name.toLowerCase().includes('.csv')
      );

      // Look for sales-related files
      const salesFiles = allFiles.filter(file => 
        file.name && (
          file.name.toLowerCase().includes('sales') ||
          file.name.toLowerCase().includes('transaction') ||
          file.name.toLowerCase().includes('revenue') ||
          file.name.toLowerCase().includes('order')
        )
      );

      await sftp.end();
      
      res.status(200).json({ 
        success: true, 
        message: 'SFTP file search completed',
        searchCriteria: {
          startDate: start.toISOString().split('T')[0],
          endDate: end.toISOString().split('T')[0],
          pathsSearched: searchPaths.length,
          pathsFound: foundPaths.length
        },
        results: {
          totalFilesFound: allFiles.length,
          filesInDateRange: dateRangeFiles.length,
          csvFiles: csvFiles.length,
          salesRelatedFiles: salesFiles.length,
          pathsWithFiles: foundPaths
        },
        files: {
          inDateRange: dateRangeFiles.slice(0, 10).map(f => ({
            name: f.name,
            path: f.searchPath,
            size: f.size,
            modified: new Date(f.modifyTime).toLocaleString(),
            type: f.type
          })),
          csvFiles: csvFiles.slice(0, 10).map(f => ({
            name: f.name,
            path: f.searchPath,
            size: f.size,
            modified: new Date(f.modifyTime).toLocaleString()
          })),
          allFiles: allFiles.slice(0, 20).map(f => ({
            name: f.name,
            path: f.searchPath,
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
          'Using same connection method that worked before',
          'Multiple key format attempts',
          'Searching for files in date range and various directories'
        ]
      }
    });
  }
}
