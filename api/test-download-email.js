// api/test-download-email.js
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

  const { sftpUsername, serverUrl, exportId, fileName, datarailsEmail, testDate } = req.body;
  
  try {
    if (!sftpUsername || !serverUrl || !exportId || !fileName || !datarailsEmail) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required parameters: sftpUsername, serverUrl, exportId, fileName, datarailsEmail' 
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
    
    let downloadedFile = null;
    let emailResult = null;
    
    try {
      // Connect to SFTP using the working configuration
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
      
      // Download the specific file
      const remotePath = `/${exportId}/${testDate}/${fileName}`;
      
      // Get file as buffer (since Vercel serverless doesn't have persistent storage)
      const fileBuffer = await sftp.get(remotePath);
      
      // Get file info
      const fileList = await sftp.list(`/${exportId}/${testDate}/`);
      const fileInfo = fileList.find(f => f.name === fileName);
      
      downloadedFile = {
        fileName: fileName,
        size: fileInfo ? fileInfo.size : fileBuffer.length,
        remotePath: remotePath,
        downloadedSize: fileBuffer.length,
        downloadTime: new Date().toISOString()
      };

      await sftp.end();
      
      // Send email with file attachment using Resend
      if (resendApiKey) {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Toast Automation <onboarding@resend.dev>',
            to: [datarailsEmail],
            subject: `Toast Sales Report - ${testDate} - ${fileName}`,
            html: `
              <p>Hello,</p>
              <p>Please find attached the Toast sales report for ${testDate}.</p>
              <p>File details:</p>
              <ul>
                <li>File name: ${fileName}</li>
                <li>Date: ${testDate}</li>
                <li>Size: ${Math.round(downloadedFile.size / 1024)} KB</li>
                <li>Downloaded: ${downloadedFile.downloadTime}</li>
              </ul>
              <p>This file was automatically downloaded from Toast POS and sent via the Toast-Datarails integration.</p>
              <p>Best regards,<br>Automated System</p>
            `,
            attachments: [
              {
                filename: fileName,
                content: fileBuffer.toString('base64')
              }
            ]
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Email sending failed: ${errorText}`);
        }

        const emailData = await response.json();
        emailResult = {
          success: true,
          messageId: emailData.id,
          to: datarailsEmail,
          subject: `Toast Sales Report - ${testDate} - ${fileName}`
        };
      } else {
        emailResult = {
          success: false,
          error: 'RESEND_API_KEY not found in environment variables'
        };
      }
      
      res.status(200).json({ 
        success: true, 
        message: 'File downloaded and email sent successfully',
        download: downloadedFile,
        email: emailResult,
        summary: {
          operation: 'Download and Email Test',
          file: fileName,
          date: testDate,
          downloadSuccess: true,
          emailSuccess: emailResult.success,
          totalTime: new Date().toISOString()
        }
      });
      
    } catch (operationError) {
      await sftp.end();
      throw operationError;
    }
    
  } catch (error) {
    console.error('Download and email test error:', error);
    res.status(500).json({ 
      success: false, 
      error: `Operation failed: ${error.message}`,
      details: {
        server: serverUrl,
        exportId: exportId,
        fileName: fileName,
        step: downloadedFile ? 'email' : 'download'
      }
    });
  }
}
