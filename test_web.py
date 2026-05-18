import urllib.request
import re
from bs4 import BeautifulSoup
html = urllib.request.urlopen('https://wiki.lckfb.com/zh-hans/lushan-pi-k230/basic/pwm.html').read().decode('utf-8')
soup = BeautifulSoup(html, 'html.parser')
for c in soup.find_all('code'):
    text = c.get_text()
    if 'PWM' in text:
        print('=== CODE ===')
        print(text[:200])
