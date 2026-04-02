# Pay API

## Create direct pay link

<mark style="color:green;">`POST`</mark> `https://back.easykash.net/api/directpayv1/pay`

To get your api key, open your [Integration Settings](https://www.easykash.net/seller/cash-api) page

### Headers

| Name                                            | Type   | Description |
| ----------------------------------------------- | ------ | ----------- |
| authorization<mark style="color:red;">\*</mark> | String | API key     |

#### Request Body

| Name                                                | Type             | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| amount<mark style="color:red;">\*</mark>            | number           | <p><strong>Base</strong> amount. Amount must be in the currency being sent and NOT in EGP.<br><br>Note: The end user will be charged in EGP (<strong>Total</strong> amount in currency sent \* Exchange Rate at the time of payment).<br><br><em>Deprecated process: </em><del><em>Amount MUST be in EGP and EasyKash will convert it to the provided currency</em></del></p>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| currency<mark style="color:red;">\*</mark>          | string           | <p>Available currency list: <br>EGP<br>USD<br>SAR<br>EUR<br>GBP<br>QAR<br>AED</p>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| paymentOptions                                      | array of numbers | <p>Note: the below payment options will ONLY appear if they are enabled to your business account.<br>Must be an array of numbers represents the payment option</p><p>Options: </p><p>1 (for Cash through AMAN)<br>2 (for Credit & Debit Card)<br>3 (for Qassatly)<br>4 (for Mobile Wallet)<br>5 (for Cash Through Fawry)<br>6 (for Meeza)<br>8 (for 6 Months - NBE installments)<br>9 (for 12 Months - NBE installments)<br>10 (for 18 Months - NBE installments)<br>17 (for ValU)<br>18 (for 6 months - Banque Misr installments)<br>19 (for 12 months - Banque Misr installments)<br>20 (for 18 months - Banque Misr installments)<br>21 (for Aman installments)<br>22 (for Souhoula)<br>23 (for Contact)<br>24 (for Mogo/MidTakseet)<br>25 (for Blnk)<br>26 (for 6 months installments - Multiple Banks)<br>27 (for 12 months installments - Multiple Banks)<br>28 (for 18 months installments - Multiple Banks)<br>29 (for Halan)<br>31 (for Apple Pay)<br>32 (for TRU)<br>33 (for Klivvr)<br>34 (for Forsa)</p> |
| cashExpiry                                          | number           | <p>Must be a number (reflects time in hours i.e: 12 means 12 hours) </p><p>If not given, a default value of 3 will be taken</p>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| name<mark style="color:red;">\*</mark>              | string           | Buyer's name                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| email<mark style="color:red;">\*</mark>             | string           | Buyer's email                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| mobile<mark style="color:red;">\*</mark>            | string           | Buyer’s mobile number as string                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| redirectUrl<mark style="color:red;">\*</mark>       | string           | The link to redirect back to your website                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| customerReference<mark style="color:red;">\*</mark> | number           | Product's reference number of the Direct Pay customer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

#### **Request Body Example:**

```
{
    "amount": 10,
    "currency": "EGP",
    "paymentOptions": [
        2,
        3,
        4,
        5,
        6
    ],
    "cashExpiry": 3,
    "name": "John Doe",
    "email": "JohnDoe@example.com",
    "mobile": "01010101010",
    "redirectUrl": "https://www.yourshop.com/",
    "customerReference": 123
}

```

{% tabs %}
{% tab title="200 Direct Pay link created successfully. User must be redirected to that link to be able to proceed with payment" %}

```javascript
{
    "redirectUrl"="https://www.easykash.net/DirectPayV1/{productCode}"
}
```

{% endtab %}
{% endtabs %}

**_The user must be redirected to the link received in the previous response to be able to proceed with payment._**

#### Direct Payment Screen:

![Direct Payment product payment options](https://598016363-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2F6PoB6b79Xd7zFLs2dbxe%2Fuploads%2FtYXxj7JLNhgfsoFT1kzk%2Fdirect-pay-screenshot.png?alt=media&token=f1f45033-f7cd-48be-9611-f50c9f9295ff)

After the buyer completes the payment on the Direct Payment screen above, EasyKash redirects them back to your website using the redirectUrl you initially sent in the first request.

The redirect link will have additional parameters embedded to it representing the basic results of the payment. You can rely on them to display custom messages on your website. (For example, if the status returned in 'success', show a customized success page/message)

For detailed payment information, use either the [Callback Service](https://easykash.gitbook.io/easykash-apis-documentation/callback-service) for automated callbacks from Easykash to your system, or the [Payment Inquiry](https://easykash.gitbook.io/easykash-apis-documentation/direct-payment-hosted/inquire-a-payment) service by inquirying about a payment.

#### **Redirect Link example:**

[https://www.yourshop.com/?status=NEW\&providerRefNum=2206290593680\&customerReference=721227](https://www.google.com/?status=NEW&providerRefNum=2206290593680&customerReference=721227)

|                       |                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------- |
| **status**            | Status of the payment (‘success’, ‘pending’, or ‘failed’)                                   |
| **providerRefNum**    | Payment Method provider reference number                                                    |
| **customerReference** | The Provided customer Reference                                                             |
| **voucher**           | Incase of Aman or Fawry payment option, Returning a Voucher Number for the customer to pay. |

# Callback Service

If you still haven't configured your Callback URL, head to your [Integration Settings](https://www.easykash.net/seller/cash-api) page and configure it ahead of this step.

- Callback URL is the URL you’ll receive the details of transactions on such as status, reference number, etc. Make sure it’s a working URL on your end that will receive and process the payload once received.

Request from Easykash (example)

```json
{
    "ProductCode": "CHQ4668",
    "PaymentMethod": "Cash Through Fawry/Cash Through Aman/Credit & Debit Card/Mobile Wallet/Meeza/Qassatly/Cash Api",
    "ProductType": "Physical Product/Invoice/Event/Quick Payment/Quick Cash/Subscription/Custom Payment/Quick Qassatly/Fawry Payout/Booking",
    "Amount": "50.5",
    "BuyerEmail": "johndoe@domain.com",
    "BuyerMobile": "01010101010",
    "BuyerName": "John Doe",
    "Timestamp": "1626166791",
    "status": "PAID",
    "voucher": "32423432",
    "easykashRef": "3242143421",
    "VoucherData": "test",
    "customerReference":"1232",
    "signatureHash":"0bd9ce502950ffa358314c170dace42e7ba3e0c776f5a32eb15c3d496bc9c294835036dd90d4f287233b800c9bde2f6591b6b8a1f675b6bfe64fd799da29d1d0"
}
```

|                       |                                                                                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ProductCode**       | Code of the product. It’s the last part of the URL of the product. E.g. "CHQ4668"                                                                                                                                                                                               |
| **PaymentMethod**     | <p>Method of payment. </p><p>All possible outcomes: </p><ul><li>Cash Through Fawry</li><li>Cash Through Aman</li><li>Credit & Debit Card</li><li>Mobile Wallet</li><li>Meeza</li><li>Qassatly</li><li>Cash Api</li></ul>                                                        |
| **ProductType**       | <p>Type of product being confirmed. </p><p>All possible outcomes:</p><ul><li>Physical Product</li><li>Invoice, Event</li><li>Quick Payment</li><li>Quick Cash</li><li>Subscription</li><li>Custom Payment</li><li>Quick Qassatly</li><li>Fawry Payout</li><li>Booking</li></ul> |
| **Amount**            | Amount paid                                                                                                                                                                                                                                                                     |
| **BuyerEmail**        | Email of the buyer                                                                                                                                                                                                                                                              |
| **BuyerMobile**       | Number of the buyer                                                                                                                                                                                                                                                             |
| **BuyerName**         | Name of the buyer                                                                                                                                                                                                                                                               |
| **Timestamp**         | Timestamp of the callback sent. e.g."1626166791"                                                                                                                                                                                                                                |
| **status**            | Status of the payment, always returns “PAID"                                                                                                                                                                                                                                    |
| **voucher**           | Payment number that the buyer uses to pay (sent only if the payment method is Cash)                                                                                                                                                                                             |
| **easykashRef**       | Reference number of the payment                                                                                                                                                                                                                                                 |
| **VoucherData**       | Title of the payment                                                                                                                                                                                                                                                            |
| **customerReference** | Your provided customer reference if provided                                                                                                                                                                                                                                    |
| **signatureHash**     | The signature can be used to validate the response, making sure it's coming from Easykash side.                                                                                                                                                                                 |

# Callback response verification

## Prerequisites&#x20;

HMAC secret key is needed for response verification, you can find it in your [Integration Settings](https://www.easykash.net/seller/cash-api) page

### HMAC calculation&#x20;

Whenever you receive a callback from Easykash, you will receive a value of the HMAC related to the data, HMAC value is **signatureHash** in response body .

In order to calculate an HMAC similar to the one you received, prepare your endpoint to perform the following:

1. Sort the data received by the following order .&#x20;

```
      ProductCode,
      Amount,
      ProductType,
      PaymentMethod,
      status,
      easykashRef,
      customerReference,

```

&#x20; 2\. Concatenate the **values of the keys/params** in one string&#x20;

3. Calculate the hash of the concatenated string using **SHA512** and your **HMAC secret key , HEX** digest&#x20;
4. Now compare both HMAC values, the one you received with the sent request and the one you calculated out of this request if both are equal you can safely use this data in your system.

### Example :&#x20;

payload example :&#x20;

```
{"ProductCode":"EDV4471","Amount":"11.00","ProductType":"Direct Pay","PaymentMethod":"Cash Through Fawry","BuyerName":"mee","BuyerEmail":"test@mail.com","BuyerMobile":"0123456789","status":"PAID","voucher":"","easykashRef":"2911105009","VoucherData":"Direct Pay","customerReference":"TEST11111","signatureHash":"0bd9ce502950ffa358314c170dace42e7ba3e0c776f5a32eb15c3d496bc9c294835036dd90d4f287233b800c9bde2f6591b6b8a1f675b6bfe64fd799da29d1d0"}
```

secret key example : da9fe30575517d987762a859842b5631&#x20;

Concatenated data = `EDV447111.00Direct PayCash Through FawryPAID2911105009TEST11111`

### Sample code :

{% tabs %}
{% tab title="Javascript" %}

```javascript
function verifyCallback(payload, secretKey) {
  // Extract data from the payload
  const {
    ProductCode,
    Amount,
    ProductType,
    PaymentMethod,
    status,
    easykashRef,
    customerReference,
    signatureHash,
  } = payload;

  // Prepare data for verification
  const dataToSocure = [
    ProductCode,
    Amount,
    ProductType,
    PaymentMethod,
    status,
    easykashRef,
    customerReference,
  ];
  const dataStr = dataToSocure.join('');

  // Generate HMAC SHA-512 hash for verification
  const calculatedSignature = crypto
    .createHmac('sha512', secretKey)
    .update(dataStr)
    .digest('hex');

  // Check if the calculated hash matches the received signatureHash
  return calculatedSignature === signatureHash;
}
```

{% endtab %}

{% tab title="PHP" %}

```php
function verifyCallback($payload, $secretKey ) {
    // Extract data from the payload
    $productCode = $payload->ProductCode;
    $amount = $payload->Amount;
    $productType = $payload->ProductType;
    $paymentMethod = $payload->PaymentMethod;
    $status = $payload->status;
    $easykashRef = $payload->easykashRef;
    $customerReference = $payload->customerReference;
    $signatureHash = $payload->signatureHash;

    // Prepare data for verification
    $dataToSecure = [
        $productCode,
        $amount,
        $productType,
        $paymentMethod,
        $status,
        $easykashRef,
        $customerReference,
    ];
    $dataStr = implode('', $dataToSecure);

    // Generate HMAC SHA-512 hash for verification
    $calculatedSignature = hash_hmac('sha512', $dataStr,  $secretKey);
    // Check if the calculated hash matches the received signatureHash
    return $calculatedSignature === $signatureHash;
}
```

{% endtab %}
{% endtabs %}

# Payment Inquiry

## Inquire about specific transaction on Easykash&#x20;

<mark style="color:green;">`POST`</mark> `https://back.easykash.net/api/cash-api/inquire`

### Headers

| Name                                            | Type   | Description |
| ----------------------------------------------- | ------ | ----------- |
| authorization<mark style="color:red;">\*</mark> | String | API key     |

#### Request Body

| Name                                                | Type   | Description                                           |
| --------------------------------------------------- | ------ | ----------------------------------------------------- |
| customerReference<mark style="color:red;">\*</mark> | String | Product's reference number of the Direct Pay customer |

#### Request Example

```json
{
    "customerReference": "111"
}
```

#### Response

|                   |                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **PaymentMethod** | <p>Method of payment. </p><p>All possible outcomes: </p><ul><li>Cash Through Fawry</li><li>Cash Through Aman</li><li>Credit & Debit Card</li><li>Mobile Wallet</li><li>Meeza</li><li>Qassatly</li><li>Cash Api</li></ul> |
| **Amount**        | Amount paid                                                                                                                                                                                                              |
| **BuyerEmail**    | Email of the buyer                                                                                                                                                                                                       |
| **BuyerMobile**   | Number of the buyer                                                                                                                                                                                                      |
| **BuyerName**     | Name of the buyer                                                                                                                                                                                                        |
| **status**        | <p>Status of the payment.</p><ul><li>DELIVERED</li><li>EXPIRED</li><li>FAILED</li><li>NEW</li><li>PAID</li><li>REFUNDED</li><li>CANCELED</li></ul>                                                                       |
| **voucher**       | Payment number that the buyer uses to pay (sent only if the payment method is Cash)                                                                                                                                      |
| **easykashRef**   | Reference number of the payment                                                                                                                                                                                          |

#### Response Example: <a href="#response-example" id="response-example"></a>

```json
{
    "PaymentMethod": "Cash Through Fawry",
    "Amount": "10.05",
    "BuyerName": "John Doe",
    "BuyerEmail": "JohnDoe@example.com",
    "BuyerMobile": "01010101010",
    "status": "PAID",
    "voucher": "32423432",
    "easykashRef": "1206102054"
}
```
