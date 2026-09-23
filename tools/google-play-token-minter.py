import os
from google.oauth2 import service_account
from google.auth.transport.requests import Request
 
credentials = service_account.Credentials.from_service_account_file(
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"],
    scopes=["https://www.googleapis.com/auth/androidpublisher"],
)
credentials.refresh(Request())
print(credentials.token)

