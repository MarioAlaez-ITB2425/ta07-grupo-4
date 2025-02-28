/***********************
 * Variables globals per a les dades
 ***********************/
let electricitatSeries = [];
let aiguaSeries = [];
let materials = {};
let serveis = {};
let lastYearMaterialsConsumption = 0;
let lastYearServicesConsumption = 0;
let materialsRawData = [];
let aiguaCalculosBase = null;
let aguaRatioSeptJun = 0;
let aguaRatioProximoAnoEstacional = 0;

/******************************
 * Funció per carregar un CSV via fetch
 ******************************/
async function loadCSV(path) {
  const response = await fetch(path);
  if (!response.ok) {
    alert("Error carregant: " + path);
    throw new Error("Error carregant " + path);
  }
  const csvText = await response.text();
  return Papa.parse(csvText, { header: true, dynamicTyping: true }).data;
}

/******************************
 * Funcions per carregar i preparar les dades
 ******************************/
async function loadConsumoAgua() {
  const data = await loadCSV("csv/TA07-G4 - Consumo agua.csv");
  return data;
}

async function loadConsumoEnergia() {
  const data = await loadCSV("csv/TA07-G4 - Consumo-Energetic.csv");
  let series = [];
  data.forEach(row => {
    const statisticalPeriod = row["Statistical Period"];
    if (statisticalPeriod) {
      let parts = statisticalPeriod.split("-");
      let year = parseInt(parts[0]);
      let month = parseInt(parts[1]) - 1;
      let day = parseInt(parts[2]);
      let d = new Date(year, month, day);
      series.push({ fecha: d, consumo: parseFloat(row["Consumption (kWh)"].replace(",", ".")) });
    } else {
      console.warn("Skipping row in Electricitat CSV due to missing 'Statistical Period' value:", row);
    }
  });
  series.sort((a, b) => a.fecha - b.fecha);
  return series;
}

async function loadMaterialsCSV() {
  const data = await loadCSV("csv/TA07-G4 - Materiales.csv");
  materialsRawData = data;
  let catMap = {};
  let totalLastYear = 0;
  data.forEach(row => {
    let categoria = row["Material"];
    let montoStr = row["total"].toString().replace("€", "").replace(/\./g, "").replace(",", ".");
    let monto = parseFloat(montoStr);
    if (!isNaN(monto)) {
      catMap[categoria] = (catMap[categoria] || 0) + monto;
      totalLastYear += monto;
    }
  });
  lastYearMaterialsConsumption = totalLastYear;
  return catMap;
}

async function loadServiciosCSV() {
  const data = await loadCSV("csv/TA07-G4 - Servicios.csv");
  let catMap = {};
  let totalLastYear = 0;
  let limpiezaJardinCostBimonthly = 0;
  data.forEach(row => {
    const serviciosValue = row["Servicios "];
    if (serviciosValue) {
      let categoria = serviciosValue.trim();
      let montoStr = row["Precio"].toString().replace("€", "").replace(/\./g, "").replace(",", ".");
      let monto = parseFloat(montoStr);
      if (!isNaN(monto)) {
        if (categoria === "Limpieza. jardin, patios y entrada") {
          limpiezaJardinCostBimonthly = monto;
          catMap[categoria] = monto * 6;
          totalLastYear += monto * 6;
        } else {
          // Per aquestes dues categories es multiplica per 12
          if (categoria === "Factura digi mayo" || categoria === "Fibra y movil noviembre ") {
            monto *= 12;
          }
          catMap[categoria] = (catMap[categoria] || 0) + monto;
          totalLastYear += monto;
        }
      }
    } else {
      console.warn("Skipping row in Servicios CSV due to missing 'Servicios ' value:", row);
    }
  });
  lastYearServicesConsumption = totalLastYear;
  return { catMap: catMap, limpiezaJardinCostBimonthly: limpiezaJardinCostBimonthly };
}

/******************************************
 * Funció de forecasting: Holt–Winters (model additiu)
 ******************************************/
function holtWinters(series, seasonLength, forecastPeriods, alpha = 0.2, beta = 0.1, gamma = 0.1) {
  if (series.length < 2 * seasonLength) return null;
  let seasonals = [];
  let seasons = Math.floor(series.length / seasonLength);
  for (let i = 0; i < seasonLength; i++) {
    let sum = 0;
    for (let j = 0; j < seasons; j++) {
      sum += series[i + j * seasonLength];
    }
    seasonals.push(sum / seasons);
  }
  let level = series.slice(0, seasonLength).reduce((a, b) => a + b, 0) / seasonLength;
  let trend = 0;
  for (let i = 0; i < seasonLength; i++) {
    trend += (series[i + seasonLength] - series[i]) / seasonLength;
  }
  trend /= seasonLength;
  let lvl = level, tr = trend;
  for (let i = 0; i < series.length; i++) {
    if (i >= seasonLength) {
      let val = series[i];
      let lastLvl = lvl;
      let seasonal = seasonals[i % seasonLength];
      lvl = alpha * (val - seasonal) + (1 - alpha) * (lvl + tr);
      tr = beta * (lvl - lastLvl) + (1 - beta) * tr;
      seasonals[i % seasonLength] = gamma * (val - lvl) + (1 - gamma) * seasonal;
    }
  }
  let forecast = [];
  for (let m = 1; m <= forecastPeriods; m++) {
    forecast.push(lvl + m * tr + seasonals[(series.length + m - seasonLength) % seasonLength]);
  }
  return forecast;
}

/******************************************
 * Funció per calcular el consum mitjà per punt de dada
 ******************************************/
function calculateAverageDataPointConsumption(series) {
  if (!series || series.length === 0) return 0;
  let totalConsumption = 0;
  series.forEach(item => {
    totalConsumption += item.consumo;
  });
  return totalConsumption / series.length;
}

/******************************************
 * Funció per calcular el consum diari mitjà d'aigua
 ******************************************/
function calculateAverageDailyWaterConsumption(series) {
  if (!series || series.length === 0) return 0;
  let totalConsumption = 0;
  series.forEach(item => {
    totalConsumption += item.consumo;
  });
  return totalConsumption / series.length;
}

/***********************
 * Variables per als gràfics
 ***********************/
let historicalChartInstance = null;

/******************************************
 * Funció per actualitzar els gràfics segons l'indicador
 ******************************************/
function updateCharts() {
  const indicator = document.getElementById("indicatorSelect").value;
  if (historicalChartInstance) historicalChartInstance.destroy();

  let labels = [];
  let dataPoints = [];
  const ctxHist = document.getElementById("historicalChart").getContext("2d");
  const calculationResultsDiv = document.getElementById("calculationResults");
  calculationResultsDiv.innerHTML = "";

  const annualExpenseLabel = document.getElementById("annualExpenseLabel");
  const monthlyExpenseOutput = document.getElementById("monthlyExpenseOutput");
  const dailyExpenseOutput = document.getElementById("dailyExpenseOutput");
  const annualExpenseInput = document.getElementById("annualExpenseInput");

  if (indicator === "Electricitat") {
    annualExpenseLabel.textContent = "kWh Anuals Totals:";
    monthlyExpenseOutput.innerHTML = "<b>kWh Mensuals Aproximats:</b> - kWh";
    dailyExpenseOutput.innerHTML = "<b>kWh Diaris Aproximats:</b> - kWh";
    annualExpenseInput.placeholder = "Introdueix els kWh anuals";

    labels = electricitatSeries.map(item => {
      let d = item.fecha;
      return d.getFullYear() + "-" +
             ("0" + (d.getMonth() + 1)).slice(-2) + "-" +
             ("0" + d.getDate()).slice(-2);
    });
    dataPoints = electricitatSeries.map(item => item.consumo);

    historicalChartInstance = new Chart(ctxHist, {
      type: "line",
      data: {
        labels: labels,
        datasets: [{
          label: "Consum (kWh)",
          data: dataPoints,
          fill: false,
          borderColor: "blue"
        }]
      }
    });

    calculationResultsDiv.innerHTML += "<h3>Càlculs d'Electricitat</h3>";

    if (electricitatSeries && electricitatSeries.length > 0) {
      let consumo_actual = electricitatSeries.reduce((sum, item) => sum + item.consumo, 0);
      let dias_registrados = electricitatSeries.length;
      let dias_totales_año = 365;
      let consumo_estimado_anual = (consumo_actual / dias_registrados) * dias_totales_año;
      let crecimiento_anual = 1.05;
      let consumo_proximo_año = consumo_estimado_anual * crecimiento_anual;

      const factores_ajuste = {
        1: 1.50,  2: 1.50,  3: 1.10,  4: 1.05,  5: 0.95,  6: 0.85,
        7: 0.80,  8: 0.80,  9: 0.90, 10: 1.05, 11: 1.10, 12: 1.50
      };

      let adjustedSeries = electricitatSeries.map(item => {
        let month = item.fecha.getMonth() + 1;
        let factor = factores_ajuste[month] || 1;
        return {
          ...item,
          adjustedConsumo: item.consumo * factor * (0.90 + Math.random() * (1.10 - 0.90))
        };
      });

      let consumo_invierno = adjustedSeries.filter(item => [12, 1, 2].includes(item.fecha.getMonth() + 1))
                                            .reduce((sum, item) => sum + item.adjustedConsumo, 0);

      let consumo_verano = adjustedSeries.filter(item => [6, 7, 8].includes(item.fecha.getMonth() + 1))
                                          .reduce((sum, item) => sum + item.adjustedConsumo, 0);

      let df_periodo = adjustedSeries.filter(item => [9, 10, 11, 12, 1, 2, 3, 4, 5, 6].includes(item.fecha.getMonth() + 1));
      let consumo_ajustado_periodo = df_periodo.reduce((sum, item) => sum + item.adjustedConsumo, 0);
      let dias_registrados_periodo = df_periodo.length;
      let dias_totales_periodo = 304;
      let consumo_estimado_periodo = (consumo_ajustado_periodo / dias_registrados_periodo) * dias_totales_periodo;

      let df_enero = adjustedSeries.filter(item => item.fecha.getMonth() + 1 === 1);
      let consumo_enero = df_enero.reduce((sum, item) => sum + item.adjustedConsumo, 0);
      let consumo_enero_multiplicado = consumo_enero * 3;
      let consumo_septiembre_junio = consumo_enero * 9;

      calculationResultsDiv.innerHTML += `<p><b>Consum estimat per aquest any:</b> ${consumo_estimado_anual.toFixed(2)} kWh</p>`;
      calculationResultsDiv.innerHTML += `<p><b>Consum estimat per al pròxim any (increment del 5%):</b> ${consumo_proximo_año.toFixed(2)} kWh</p>`;
      calculationResultsDiv.innerHTML += `<p><b>Consum ajustat total en els mesos d'hivern:</b> ${consumo_invierno.toFixed(2)} kWh</p>`;
      calculationResultsDiv.innerHTML += `<p><b>Consum ajustat total en el mes d'agost:</b> ${consumo_verano.toFixed(2)} kWh</p>`;
      calculationResultsDiv.innerHTML += `<p><b>Consum ajustat estimat per als tres mesos d'hivern:</b> ${consumo_enero_multiplicado.toFixed(2)} kWh</p>`;
      calculationResultsDiv.innerHTML += `<p><b>Consum ajustat estimat per al període setembre - juny:</b> ${consumo_septiembre_junio.toFixed(2)} kWh</p>`;
    }

  } else if (indicator === "Aigua") {
    annualExpenseLabel.textContent = "Líters Anuals Totals:";
    monthlyExpenseOutput.innerHTML = "<b>Líters Mensuals Aproximats:</b> - líters";
    dailyExpenseOutput.innerHTML = "<b>Líters Diaris Aproximats:</b> - líters";
    annualExpenseInput.placeholder = "Introdueix els líters anuals";

    labels = aiguaSeries.map(row => {
      let parts = row["Dia"].split("/");
      let d = new Date(parts[2], parts[1] - 1, parts[0]);
      return d.getFullYear() + "-" +
             ("0" + (d.getMonth() + 1)).slice(-2) + "-" +
             ("0" + d.getDate()).slice(-2);
    });
    dataPoints = aiguaSeries.map(item => parseFloat(item["Consumo (litros)"] || 0));

    historicalChartInstance = new Chart(ctxHist, {
      type: "line",
      data: {
        labels: labels,
        datasets: [{
          label: "Consum (líters)",
          data: dataPoints,
          fill: false,
          borderColor: "green"
        }]
      }
    });

    calculationResultsDiv.innerHTML += "<h3>Càlculs d'Aigua</h3>";
    var calcResults = calcularConsumo(aiguaSeries);
    if (calcResults) {
      calculationResultsDiv.innerHTML += `
        <p><b>Consum total projectat anual:</b> ${calcResults.consumoTotalAnual.toFixed(2)} líters</p>
        <p><b>Consum ajustat amb tendències estacionals (setembre a juny):</b> ${calcResults.consumoPeriodoAjustado.toFixed(2)} líters</p>
        <p><b>Pronòstic ajustat per al pròxim any amb estacionalitat:</b> ${calcResults.consumoProximoAnoEstacional.toFixed(2)} líters</p>
      `;
      aiguaCalculosBase = calcResults;
      aguaRatioSeptJun = aiguaCalculosBase.consumoPeriodoAjustado / aiguaCalculosBase.consumoTotalAnual;
      aguaRatioProximoAnoEstacional = aiguaCalculosBase.consumoProximoAnoEstacional / aiguaCalculosBase.consumoTotalAnual;
    } else {
      calculationResultsDiv.innerHTML += "<p>No s'han pogut calcular els resultats de consum d'aigua.</p>";
      aiguaCalculosBase = null;
      aguaRatioSeptJun = 0;
      aguaRatioProximoAnoEstacional = 0;
    }

  } else if (indicator === "Materials (Consumibles d'oficina)") {
    annualExpenseLabel.textContent = "Despesa Anual Total (€):";
    monthlyExpenseOutput.innerHTML = "<b>Despesa Mensual Aproximada:</b> - €";
    dailyExpenseOutput.innerHTML = "<b>Despesa Diària Aproximada:</b> - €";
    annualExpenseInput.placeholder = "Introdueix la despesa anual";

    labels = Object.keys(materials);
    dataPoints = Object.values(materials);
    historicalChartInstance = new Chart(ctxHist, {
      type: "bar",
      data: {
        labels: labels,
        datasets: [{
          label: "Import (€)",
          data: dataPoints,
          backgroundColor: "orange"
        }]
      },
      options: { scales: { y: { beginAtZero: true } } }
    });
    calculationResultsDiv.innerHTML += "<h3>Càlculs de Materials (Consumibles d'oficina)</h3>";
    const nextYearMaterialsForecast = lastYearMaterialsConsumption;
    const periodMaterialsForecast = (nextYearMaterialsForecast / 12) * 10;

    function aproximarConsumoProximoAnioMaterials(data) {
      if (!data || data.length === 0) return 0;
      const monthlyConsumption = {};
      data.forEach(row => {
        const fechaCompraStr = row['fecha compra'];
        if (fechaCompraStr) {
          const parts = fechaCompraStr.split('/');
          const day = parseInt(parts[0], 10);
          const month = parseInt(parts[1], 10);
          const year = parseInt(parts[2], 10);
          const fechaCompra = new Date(year, month - 1, day);
          const monthNumber = fechaCompra.getMonth() + 1;
          const total = parseFloat(row['total'].toString().replace("€", "").replace(/\./g, "").replace(",", ".")) || 0;
          monthlyConsumption[monthNumber] = (monthlyConsumption[monthNumber] || 0) + total;
        }
      });
      let totalMonthlyConsumption = 0;
      let monthsCount = 0;
      for (const month in monthlyConsumption) {
        totalMonthlyConsumption += monthlyConsumption[month];
        monthsCount++;
      }
      const averageMonthlyConsumption = monthsCount > 0 ? totalMonthlyConsumption / monthsCount : 0;
      const consumoProximoAnio = averageMonthlyConsumption * 12;
      return consumoProximoAnio;
    }

    function calcularCantidadTotalMaterials(data) {
      if (!data || data.length === 0) return 0;
      let cantidadTotal = 0;
      data.forEach(row => {
        const cantidad = parseInt(row['cantidad'], 10) || 0;
        cantidadTotal += cantidad;
      });
      return cantidadTotal;
    }

    const consumoProximoAnioMaterials = aproximarConsumoProximoAnioMaterials(materialsRawData);
    const cantidadTotalConsumibles = calcularCantidadTotalMaterials(materialsRawData);

    calculationResultsDiv.innerHTML += "<p><b>Consum de consumibles d’oficina del pròxim any (Mitjana de l'any anterior):</b> " + nextYearMaterialsForecast.toFixed(2) + " €</p>";
    calculationResultsDiv.innerHTML += "<p><b>Consum de consumibles d’oficina de setembre a juny (Mitjana proporcional de l'any anterior):</b> " + periodMaterialsForecast.toFixed(2) + " €</p>";
    calculationResultsDiv.innerHTML += "<p><b>Cost mensual mitjà de consumibles d’oficina:</b> " + (nextYearMaterialsForecast / 12).toFixed(2) + " €</p>";
    calculationResultsDiv.innerHTML += `<p><b>Cost diari mitjà de consumibles d’oficina:</b> ${(nextYearMaterialsForecast / (365.25 / 12)).toFixed(2)} €</p>`;
    calculationResultsDiv.innerHTML += `<p><b>Consum total aproximat per al pròxim any:</b> ${consumoProximoAnioMaterials.toFixed(2)} €</p>`;
    calculationResultsDiv.innerHTML += `<p><b>Quantitat total de consumibles demanats durant l'any:</b> ${cantidadTotalConsumibles}</p>`;

  } else if (indicator === "Serveis") {
    annualExpenseLabel.textContent = "Despesa Anual Total (€):";
    monthlyExpenseOutput.innerHTML = "<b>Despesa Mensual Aproximada:</b> - €";
    dailyExpenseOutput.innerHTML = "<b>Despesa Diària Aproximada:</b> - €";
    annualExpenseInput.placeholder = "Introdueix la despesa anual";

    labels = Object.keys(serveis.catMap);
    dataPoints = Object.values(serveis.catMap);
    historicalChartInstance = new Chart(ctxHist, {
      type: "bar",
      data: {
        labels: labels,
        datasets: [{
          label: "Import (€)",
          data: dataPoints,
          backgroundColor: "purple"
        }]
      },
      options: { scales: { y: { beginAtZero: true } } }
    });

    calculationResultsDiv.innerHTML += "<h3>Càlculs de Serveis</h3>";

    const nextYearTotalServicesForecast = lastYearServicesConsumption;
    const monthlyServicesCost = nextYearTotalServicesForecast / 12;
    const dailyServicesCost = monthlyServicesCost / (365.25 / 12);

    calculationResultsDiv.innerHTML += "<p><b>Cost total de tots els serveis del pròxim any (Mitjana de l'any anterior):</b> " + nextYearTotalServicesForecast.toFixed(2) + " €</p>";
    calculationResultsDiv.innerHTML += "<p><b>Cost mensual mitjà de tots els serveis:</b> " + monthlyServicesCost.toFixed(2) + " €</p>";
    calculationResultsDiv.innerHTML += `<p><b>Cost diari mitjà de tots els serveis:</b> ${dailyServicesCost.toFixed(2)} €</p>`;

    const bimonthlyCleaningCost = serveis.limpiezaJardinCostBimonthly;
    const annualCleaningCost = bimonthlyCleaningCost * 6;
    const periodCleaningCost = bimonthlyCleaningCost * 5;

    calculationResultsDiv.innerHTML += `<p><b>Cost anual del servei de neteja (Cost bimestral anualitzat):</b> ${annualCleaningCost.toFixed(2)} €</p>`;
    calculationResultsDiv.innerHTML += `<p><b>Cost del servei de neteja durant el període de setembre a juny (Cost bimestral proporcional):</b> ${periodCleaningCost.toFixed(2)} €</p>`;
  }
  calculateMonthlyDailyExpense();
}

/******************************************
 * Calculadora de Despesa Anual - Funcionalitat
 ******************************************/
function calculateMonthlyDailyExpense() {
  const annualExpenseInput = document.getElementById("annualExpenseInput");
  const monthlyExpenseOutput = document.getElementById("monthlyExpenseOutput");
  const dailyExpenseOutput = document.getElementById("dailyExpenseOutput");
  const annualCalculationsOutput = document.getElementById("annualCalculationsOutput");
  const indicator = document.getElementById("indicatorSelect").value;
  const annualExpense = parseFloat(annualExpenseInput.value);
  let monthlyExpense = 0;
  let dailyExpense = 0;
  let monthlyUnit = "€";
  let dailyUnit = "€";

  if (!isNaN(annualExpense)) {
    monthlyExpense = annualExpense / 12;
    dailyExpense = annualExpense / 365.25;
  }

  if (indicator === "Electricitat") {
    monthlyUnit = "kWh";
    dailyUnit = "kWh";
  } else if (indicator === "Aigua") {
    monthlyUnit = "líters";
    dailyUnit = "líters";
  }

  monthlyExpenseOutput.innerHTML = `<b>Despesa Mensual Aproximada:</b> ${monthlyExpense.toFixed(2)} ${monthlyUnit}`;
  dailyExpenseOutput.innerHTML = `<b>Despesa Diària Aproximada:</b> ${dailyExpense.toFixed(2)} ${dailyUnit}`;

  if (!isNaN(annualExpense)) {
    const annualCalcs = calculateCalculationsFromAnnualExpense(annualExpense, indicator);
    let outputHTML = "";
    if (annualCalcs) {
      if (indicator === "Electricitat") {
        outputHTML += `<p><b>Consum estimat per aquest any:</b> ${annualCalcs.consumo_estimado_anual.toFixed(2)} kWh</p>`;
        outputHTML += `<p><b>Consum estimat per al pròxim any (increment del 5%):</b> ${annualCalcs.consumo_proximo_año.toFixed(2)} kWh</p>`;
        outputHTML += `<p><b>Consum ajustat total en els mesos d'hivern:</b> ${annualCalcs.consumo_invierno.toFixed(2)} kWh</p>`;
        outputHTML += `<p><b>Consum ajustat total en el mes d'agost:</b> ${annualCalcs.consumo_verano.toFixed(2)} kWh</p>`;
        outputHTML += `<p><b>Consum ajustat estimat per als tres mesos d'hivern:</b> ${annualCalcs.consumo_enero_multiplicado.toFixed(2)} kWh</p>`;
      } else if (indicator === "Aigua") {
        if (aiguaCalculosBase) {
          const consumo_sept_jun_user_input = annualCalcs.consumo_sept_jun_user_input;
          outputHTML += `<p><b>Consum total projectat anual:</b> ${annualExpense.toFixed(2)} líters</p>`;
          outputHTML += `<p><b>Consum ajustat amb tendències estacionals (setembre a juny):</b> ${consumo_sept_jun_user_input.toFixed(2)} líters</p>`;
        } else {
          outputHTML += "<p>No s'han pogut realitzar els càlculs detallats per Aigua.</p>";
        }
      } else if (indicator === "Materials (Consumibles d'oficina)") {
        outputHTML += `
          <p><b>Consum de consumibles d’oficina del pròxim any (Mitjana de l'any anterior):</b> ${annualCalcs.consumo_proximo_anio.toFixed(2)} €</p>
          <p><b>Consum de consumibles d’oficina de setembre a juny (Mitjana proporcional de l'any anterior):</b> ${annualCalcs.consumo_septiembre_junio.toFixed(2)} €</p>
          <p><b>Consum total aproximat per al pròxim any:</b> ${annualCalcs.consumo_total_proximo_anio.toFixed(2)} €</p>
        `;
      } else if (indicator === "Serveis") {
        outputHTML += `
          <p><b>Cost total de tots els serveis del pròxim any (Mitjana de l'any anterior):</b> ${annualCalcs.costo_total_proximo_anio.toFixed(2)} €</p>
          <p><b>Cost anual del servei de neteja (Cost bimestral anualitzat):</b> ${annualCalcs.costo_anual_limpieza.toFixed(2)} €</p>
          <p><b>Cost del servei de neteja durant el període de setembre a juny (Cost bimestral proporcional):</b> ${annualCalcs.costo_periodo_limpieza.toFixed(2)} €</p>
        `;
      }
    } else {
      outputHTML = "<p>No s'han pogut realitzar els càlculs anuals.</p>";
    }
    annualCalculationsOutput.innerHTML = outputHTML;
  } else {
    annualCalculationsOutput.innerHTML = "";
  }
}

function calculateCalculationsFromAnnualExpense(annualExpense, indicator) {
  if (indicator === "Electricitat") {
    let consumo_estimado_anual = annualExpense;
    let crecimiento_anual = 1.05;
    let consumo_proximo_año = consumo_estimado_anual * crecimiento_anual;

    const factores_ajuste = {
      1: 1.50,  2: 1.50,  3: 1.10,  4: 1.05,  5: 0.95,  6: 0.85,
      7: 0.80,  8: 0.80,  9: 0.90, 10: 1.05, 11: 1.10, 12: 1.50
    };

    const monthly_average = consumo_estimado_anual / 12;
    let adjustedSeries = [];
    for (let month = 1; month <= 12; month++) {
      let factor = factores_ajuste[month] || 1;
      adjustedSeries.push({
        month: month,
        adjustedConsumo: monthly_average * factor * (0.90 + Math.random() * (1.10 - 0.90))
      });
    }

    let consumo_invierno = adjustedSeries.filter(item => [12, 1, 2].includes(item.month))
                                          .reduce((sum, item) => sum + item.adjustedConsumo, 0);

    let consumo_verano = adjustedSeries.filter(item => [6, 7, 8].includes(item.month))
                                        .reduce((sum, item) => sum + item.adjustedConsumo, 0);

    let df_periodo = adjustedSeries.filter(item => [9, 10, 11, 12, 1, 2, 3, 4, 5, 6].includes(item.month));
    let consumo_ajustado_periodo = df_periodo.reduce((sum, item) => sum + item.adjustedConsumo, 0);
    let consumo_estimado_periodo = consumo_ajustado_periodo;
    let df_enero = adjustedSeries.filter(item => item.month === 1);
    let consumo_enero = df_enero.reduce((sum, item) => sum + item.adjustedConsumo, 0);
    let consumo_enero_multiplicado = consumo_enero * 3;
    let consumo_septiembre_junio = consumo_enero * 9;

    return {
      consumo_estimado_anual: consumo_estimado_anual,
      consumo_proximo_año: consumo_proximo_año,
      consumo_invierno: consumo_invierno,
      consumo_verano: consumo_verano,
      consumo_enero_multiplicado: consumo_enero_multiplicado,
      consumo_septiembre_junio: consumo_septiembre_junio
    };
  } else if (indicator === "Aigua") {
    if (aiguaCalculosBase) {
      return {
        consumo_sept_jun_user_input: annualExpense * aguaRatioSeptJun,
        consumo_proximo_ano_estacional_user_input: annualExpense * aguaRatioProximoAnoEstacional
      };
    } else {
      return null;
    }
  } else if (indicator === "Materials (Consumibles d'oficina)") {
    const consumo_proximo_anio = annualExpense;
    const consumo_septiembre_junio = (annualExpense / 12) * 10;
    const consumo_total_proximo_anio = annualExpense;

    return {
      consumo_proximo_anio: consumo_proximo_anio,
      consumo_septiembre_junio: consumo_septiembre_junio,
      consumo_total_proximo_anio: consumo_total_proximo_anio
    };
  } else if (indicator === "Serveis") {
    const costo_total_proximo_anio = annualExpense;
    // Estimació: 15% per a neteja
    const cleaning_proportion = 0.15;
    const costo_anual_limpieza = annualExpense * cleaning_proportion;
    const costo_periodo_limpieza = costo_anual_limpieza * (10/12);

    return {
      costo_total_proximo_anio: costo_total_proximo_anio,
      costo_anual_limpieza: costo_anual_limpieza,
      costo_periodo_limpieza: costo_periodo_limpieza
    };
  }
  return null;
}

document.getElementById("annualExpenseInput").addEventListener("input", calculateMonthlyDailyExpense);

// Funció que actualitza les recomanacions segons l'indicador i l'estat del checkbox
function updateRecommendations() {
  const recsDiv = document.getElementById("recsDiv");
  const showRecsCheckbox = document.getElementById("showRecs");
  if (showRecsCheckbox.checked) {
    const indicator = document.getElementById("indicatorSelect").value;
    const recommendations = {
      "Electricitat": [
        "Instal·lar il·luminació LED.",
        "Sensors de moviment.",
        "Implementar sistemes d'automatització per optimitzar l'ús dels equips."
      ],
      "Aigua": [
        "Instal·lar dispositius de baix consum en grifos i sanitaris.",
        "Revisar i reparar fuites en la xarxa de distribució d'aigua.",
        "Fomentar campanyes de conscienciació sobre l'ús responsable de l'aigua."
      ],
      "Materials (Consumibles d'oficina)": [
        "Reutilitzar materials.",
        "Fer ús de material recarregable.",
        "Digitalització.",
        "Intercanvi de material."
      ],
      "Serveis": [
        "Revisar i ajustar tarifes.",
        "Promoure una cultura sobre la neteja.",
        "Comparar serveis i cercar una millor oferta."
      ]
    };
    const recs = recommendations[indicator] || [];
    recsDiv.innerHTML = "<h3>Recomanacions per " + indicator + "</h3><ul>" +
      recs.map(r => "<li>" + r + "</li>").join('') + "</ul>";
    recsDiv.style.display = "block";
  } else {
    recsDiv.style.display = "none";
  }
}

// Esdeveniments per actualitzar els gràfics i recomanacions
document.getElementById("indicatorSelect").addEventListener("change", () => {
  updateCharts();          // Primer actualitza els càlculs i el gràfic
  updateRecommendations(); // Després mostra/amaga/actualitza les recomanacions si escau
});
document.getElementById("showRecs").addEventListener("change", updateRecommendations);

async function loadAllData() {
  try {
    electricitatSeries = await loadConsumoEnergia();
  } catch (e) { console.error("Error carregant Electricitat:", e); }
  try {
    aiguaSeries = await loadConsumoAgua();
  } catch (e) { console.error("Error carregant Aigua:", e); }
  try {
    materials = await loadMaterialsCSV();
  } catch (e) { console.error("Error carregant Materials:", e); }
  try {
    serveis = await loadServiciosCSV();
    console.log('loadServiciosCSV completed', serveis);
  } catch (e) { console.error("Error carregant Serveis:", e); }
  updateCharts();
}

loadAllData();

function logError(message) {
  console.error(message);
}

function calcularConsumo(data) {
  try {
    data.forEach(function(row) {
      var parts = row["Dia"].split("/");
      if (parts.length === 3) {
        var day = parseInt(parts[0], 10);
        var month = parseInt(parts[1], 10);
        var year = parseInt(parts[2], 10);
        row.parsedDate = new Date(year, month - 1, day);
      } else {
        row.parsedDate = new Date(row["Dia"]);
      }
      var jsDay = row.parsedDate.getDay();
      row.diaSemana = (jsDay + 6) % 7;
      row.categoria = (row.diaSemana >= 5) ? "Caps de setmana" : "De dilluns a divendres";
      var y = row.parsedDate.getFullYear();
      var m = ('0' + (row.parsedDate.getMonth() + 1)).slice(-2);
      row.mes = y + "-" + m;
      row.consumo = parseFloat(row["Consumo (litros)"]);
      if (isNaN(row.consumo)) row.consumo = 0;
    });

    var februaryData = data.filter(function(row) {
      return row.mes === "2024-02";
    });

    var grupos = { "De dilluns a divendres": 0, "Caps de setmana": 0 };
    februaryData.forEach(function(row) {
      if (row.categoria in grupos) {
        grupos[row.categoria] += row.consumo;
      }
    });

    var litrosLunesViernes = grupos["De dilluns a divendres"] * 5 * 4;
    var litrosFinDeSemana = grupos["Caps de setmana"] * 2 * 4;
    var totalConsumoFebrero = litrosLunesViernes + litrosFinDeSemana;

    var consumoSemanalLunesViernes = litrosLunesViernes * 4;
    var consumoSemanalFinDeSemana = litrosFinDeSemana * 4;
    var consumoTotalSeptJun = (consumoSemanalLunesViernes + consumoSemanalFinDeSemana) * 9;

    var consumoAnualLunesViernes = litrosLunesViernes * 52;
    var consumoAnualFinDeSemana = litrosFinDeSemana * 52;
    var consumoTotalAnual = consumoAnualLunesViernes + consumoAnualFinDeSemana;

    var consumoProximoAno = consumoTotalAnual * 1.05;

    var factoresEstacionales = {
      "Gener": 1.10, "Febrer": 1.05, "Març": 1.00, "Abril": 1.02,
      "Maig": 1.08, "Juny": 1.15, "Juliol": 1.20, "Agost": 1.15,
      "Setembre": 1.05, "Octubre": 1.02, "Novembre": 1.05, "Desembre": 1.10
    };
    var sumaFactores = 0, count = 0;
    for (var key in factoresEstacionales) {
      sumaFactores += factoresEstacionales[key];
      count++;
    }
    var promedioFactor = sumaFactores / count;

    var consumoAnualAjustado = 0;
    for (var key in factoresEstacionales) {
      consumoAnualAjustado += consumoTotalAnual * factoresEstacionales[key];
    }
    var consumoPeriodoAjustado = consumoTotalSeptJun * promedioFactor;
    var consumoProximoAnoEstacional = consumoProximoAno * promedioFactor;

    return {
      totalConsumoFebrero: totalConsumoFebrero,
      consumoTotalSeptJun: consumoTotalSeptJun,
      consumoTotalAnual: consumoTotalAnual,
      consumoProximoAno: consumoProximoAno,
      consumoAnualAjustado: consumoAnualAjustado,
      consumoPeriodoAjustado: consumoPeriodoAjustado,
      consumoProximoAnoEstacional: consumoProximoAnoEstacional
    };
  } catch (error) {
    logError("Error en calcular els líters: " + error);
    return null;
  }
}
