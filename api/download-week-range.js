// api/download-week-range.js
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

  const { sftpUsername, serverUrl, exportId, startDate, endDate, datarailsEmail, fileType } = req.body;
  
  try {
    if (!sftpUsername || !serverUrl || !exportId || !startDate || !endDate || !datarailsEmail) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required parameters: sftpUsername, serverUrl, exportId, startDate, endDate, datarailsEmail' 
      });
    }

    const privateKey = process.env.TOAST_SSH_PRIVATE_KEY;
    const resendApiKey = process.env.RESEND_API_KEY;
    
    if (!privateKey) {
      return res.status(400).json({ 
        success: false, 
        error: 'SSH key not found in environment variables' 
      });
    }

    if (!resendApiKey) {
      return res.status(400).json({ 
        success: false, 
        error: 'RESEND_API_KEY not found in environment variables' 
      });
    }

    const { default: SftpClient } = await import('ssh2-sftp-client');
    const sftp = new SftpClient();
    
    let downloadedFiles = [];
    let totalSize = 0;
    
    try {
      // Connect to SFTP
      let cleanKey = privateKey.trim();
      if (!cleanKey.includes('-----BEGIN') && !cleanKey.includes('-----END')) {
        cleanKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${cleanKey}\n-----END OPENSSH PRIVATE KEY-----`;
      }
      cleanKey = cleanKey.replace(/\\n/g, '\n');
      
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
        }
      ];

      let connected = false;
      let connectionError;

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
      
      // Generate date range
      const start = new Date(startDate);
      const end = new Date(endDate);
      const dates = [];
      
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const yyyymmdd = d.getFullYear() + 
                         String(d.getMonth() + 1).padStart(2, '0') + 
                         String(d.getDate()).padStart(2, '0');
        dates.push(yyyymmdd);
      }
      
      // Target file to download (default to OrderDetails.csv for sales data)
      const targetFile = fileType || 'OrderDetails.csv';
      
      // Download files from each date
      for (const date of dates) {
        try {
          const remotePath = `/${exportId}/${date}/${targetFile}`;
          
          // Check if file exists
          const fileList = await sftp.list(`/${exportId}/${date}/`);
          const fileExists = fileList.find(f => f.name === targetFile);
          
          if (fileExists) {
            // Download the file
            const fileBuffer = await sftp.get(remotePath);
            
            downloadedFiles.push({
              date: date,
              fileName: `${date}_${targetFile}`,
              originalName: targetFile,
              size: fileExists.size,
              downloadedSize: fileBuffer.length,
              buffer: fileBuffer,
              remotePath: remotePath
            });
            
            totalSize += fileBuffer.length;
          } else {
            downloadedFiles.push({
              date: date,
              fileName: `${date}_${targetFile}`,
              originalName: targetFile,
              size: 0,
              downloadedSize: 0,
              buffer: null,
              remotePath: remotePath,
              error: 'File not found'
            });
          }
          
        } catch (dateError) {
          downloadedFiles.push({
            date: date,
            fileName: `${date}_${targetFile}`,
            originalName: targetFile,
            size: 0,
            downloadedSize: 0,
            buffer: null,
            remotePath: `/${exportId}/${date}/${targetFile}`,
            error: dateError.message
          });
        }
      }

      await sftp.end();
      
      // Prepare email with all files attached
      const attachments = downloadedFiles
        .filter(file => file.buffer !== null)
        .map(file => ({
          filename: file.fileName,
          content: file.buffer.toString('base64')
        }));
      
      const successfulDownloads = downloadedFiles.filter(f => f.buffer !== null);
      const failedDownloads = downloadedFiles.filter(f => f.buffer === null);
      
      // Send email with all attachments
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'Toast Automation <onboarding@resend.dev>',
          to: [datarailsEmail],
          subject: `Toast Weekly Sales Report - ${startDate} to ${endDate} - ${targetFile}`,
          html: `
            <p>Hello,</p>
            <p>Please find attached the Toast sales reports for the period ${startDate} to ${endDate}.</p>
            
            <h3>Successfully Downloaded Files (${successfulDownloads.length}):</h3>
            <ul>
              ${successfulDownloads.map(f => `
                <li>${f.fileName} - ${Math.round(f.size / 1024)} KB</li>
              `).join('')}
            </ul>
            
            ${failedDownloads.length > 0 ? `
            <h3>Files Not Available (${failedDownloads.length}):</h3>
            <ul>
              ${failedDownloads.map(f => `
                <li>${f.date} - ${f.error || 'File not found'}</li>
              `).join('')}
            </ul>
            ` : ''}
            
            <p><strong>Total Data:</strong> ${Math.round(totalSize / 1024)} KB</p>
            <p><strong>Date Range:</strong> ${startDate} to ${endDate}</p>
            <p><strong>File Type:</strong> ${targetFile}</p>
            
            <p>This weekly report was automatically downloaded from Toast POS and sent via the Toast-Datarails integration.</p>
            <p>Best regards,<br>Automated System</p>
          `,
          attachments: attachments
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Email sending failed: ${errorText}`);
      }

      const emailData = await response.json();
      
      res.status(200).json({ 
        success: true, 
        message: 'Weekly files downloaded and email sent successfully',
        summary: {
          dateRange: `${startDate} to ${endDate}`,
          fileType: targetFile,
          totalFiles: downloadedFiles.length,
          successfulDownloads: successfulDownloads.length,
          failedDownloads: failedDownloads.length,
          totalSize: `${Math.round(totalSize / 1024)} KB`,
          emailMessageId: emailData.id
        },
        downloads: downloadedFiles.map(f => ({
          date: f.date,
          fileName: f.fileName,
          size: f.size,
          success: f.buffer !== null,
          error: f.error || null
        })),
        email: {
          success: true,
          messageId: emailData.id,
          to: datarailsEmail,
          attachmentCount: attachments.length
        }
      });
      
    } catch (operationError) {
      await sftp.end();
      throw operationError;
    }
    
  } catch (error) {
    console.error('Weekly download error:', error);
    res.status(500).json({ 
      success: false, 
      error: `Weekly download failed: ${error.message}`,
      details: {
        server: serverUrl,
        exportId: exportId,
        dateRange: `${startDate} to ${endDate}`
      }
    });
  }
}
