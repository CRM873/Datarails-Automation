// api/test-email.js
const nodemailer = require('nodemailer');

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

  const { senderEmail, senderPassword, datarailsEmail } = req.body;
  
  try {
    // Validate required fields
    if (!senderEmail || !senderPassword || !datarailsEmail) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required email configuration' 
      });
    }
    
    // Create email transporter
    const transporter = nodemailer.createTransporter({
      service: 'gmail',
      auth: {
        user: senderEmail,
        pass: senderPassword
      }
    });
    
    // Test the connection
    await transporter.verify();
    
    // Send test email
    const testMailOptions = {
      from: senderEmail,
      to: datarailsEmail,
      subject: 'Toast-Datarails Integration Test Email',
      html: `
        <p>Hello,</p>
        <p>This is a test email from the Toast-Datarails automation system.</p>
        <p>If you receive this email, the email configuration is working correctly.</p>
        <p>Test details:</p>
        <ul>
          <li>Sender: ${senderEmail}</li>
          <li>Recipient: ${datarailsEmail}</li>
          <li>Time: ${new Date().toLocaleString()}</li>
        </ul>
        <p>Best regards,<br>Automated System</p>
      `
    };
    
    const result = await transporter.sendMail(testMailOptions);
    
    res.status(200).json({ 
      success: true, 
      message: 'Test email sent successfully',
      details: {
        from: senderEmail,
        to: datarailsEmail,
        messageId: result.messageId
      }
    });
    
  } catch (error) {
    console.error('Email test error:', error);
    res.status(500).json({ 
      success: false, 
      error: `Email test failed: ${error.message}`,
      details: {
        sender: senderEmail,
        recipient: datarailsEmail
      }
    });
  }
}
